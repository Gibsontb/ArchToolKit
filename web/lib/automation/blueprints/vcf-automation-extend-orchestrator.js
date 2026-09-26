/**
 * Orchestrator as an estate of its own: the inventory endpoints workflows call
 * through (REST, PowerShell, SSH, Active Directory, SQL), the configuration
 * elements and scheduled runs they depend on, moving a package from one
 * Orchestrator to another, and the VCF Automation secrets and ABX action
 * constants templates and actions read.
 *
 * Each is an Orchestrator package whose workflow applies it through the
 * Orchestrator (or VCF Automation) REST API, looking up what exists first and
 * leaving it alone; secrets come from SecureString attributes typed in after
 * import, or from files on the machine running the fallback script — never
 * from anything written here.
 */

import { bool, num, str,                      } from '../../kit/blueprint.js';
import { error, info, warning,              } from '../../core/findings.js';
                                                                   
import { automationBlueprint } from '../from-automation.js';
import { slugOf,                 } from '../automation.js';
import { authHeader, authPreamble } from '../apply.js';
import { apiStep, importMd, manualStep } from '../vcfa-import.js';
import { packageNameOf, toPackage } from '../vro/to-package.js';
import { familyOf } from '../../core/ip.js';
import { PKG_REQUIRES, PLATFORM, RECURRENCE, SRC, VCFA_LOGIN, VERIFY_LOGIN, elementName, guardSettings, json, lookupActions, packageSteps, q, rowsOf, scheduledTaskBody, underScripts, vcfaActions, vcfaSettings, vroValue } from './vcf-automation-extend-core.js';

/** A host name, IPv4 address or IPv6 address (bracketed in a URL). */
const hostOk = (host        )          => familyOf(host) !== null || /^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*$/.test(host);
const inUrl = (host        )         => (familyOf(host) === 6 ? `[${host}]` : host);

/**
 * Runs an Orchestrator workflow through the REST API with parameters, and waits
 * for it: POST /vco/api/workflows/{id}/executions answers 202 with the
 * execution in Location; GET …/executions/{id}/state until it is no longer
 * running. Throws when it does not end in "completed".
 */
function runWorkflowAction(packageName        ) {
  return {
    name: 'runWorkflow',
    description:
      'Run an Orchestrator workflow with parameters through the REST API (POST /vco/api/workflows/{id}/executions, then GET …/state every 2 s), and wait until it ends. Throws unless it ends "completed"; the error names its state and the start of its log. Parameters are [{ name, type, value: { <type>: { value } } }].',
    resultType: 'string',
    params: [
      { name: 'host', type: 'string', description: 'Orchestrator host' },
      { name: 'auth', type: 'Any', description: 'Bearer header' },
      { name: 'safe', type: 'Any', description: 'http options' },
      { name: 'workflowId', type: 'string', description: 'The workflow to run' },
      { name: 'parameters', type: 'Any', description: 'The execution parameters' },
      { name: 'timeoutSeconds', type: 'number', description: 'How long to wait' },
    ],
    script: `var core = System.getModule("vcf.automation.core");\nvar mod = System.getModule(${q(packageName)});\n${String.raw`var base = "https://" + host + "/vco/api/workflows/" + workflowId + "/executions";
var started = core.http("POST", base, auth, { parameters: parameters }, safe);
var id = null;
if (started.body && started.body.id) id = String(started.body.id);
if (!id) {
  var listed = core.http("GET", base + "?maxResult=1", auth, null, safe).body || {};
  var rel = (listed.relations && listed.relations.link) || listed.link || [];
  if (rel.length > 0 && rel[0].href) id = String(rel[0].href).replace(/\/+$/, "").split("/").pop();
}
if (!id) throw new Error("The execution of workflow " + workflowId + " started but its id was not returned; look under its runs.");
var deadline = new Date().getTime() + (timeoutSeconds > 0 ? timeoutSeconds : 300) * 1000;
var state = "running";
while (state === "running" || state === "waiting-signal" || state === "waiting") {
  if (new Date().getTime() > deadline) throw new Error("Workflow run " + id + " still " + state + " after " + timeoutSeconds + " s; it keeps running, check it in the client.");
  System.sleep(2000);
  var s = core.http("GET", base + "/" + id + "/state", auth, null, safe).body || {};
  state = String(s.value || s.state || "unknown");
}
if (state !== "completed") {
  var logs = core.http("GET", base + "/" + id + "/syslogs?maxResult=5", auth, null, { redact: safe && safe.redact, allow: [404] }).text || "";
  throw new Error("Workflow run " + id + " ended " + state + (logs ? ": " + logs.substring(0, 300) : ""));
}
return id;`}`,
  };
}

/** A lookup in the Orchestrator inventory catalog by name: GET /vco/api/catalog/<plugin>/<type>?conditions=name=<name>. */
function catalogAction(packageName        ) {
  return {
    name: 'catalogHas',
    description: 'Whether the Orchestrator inventory has an object of this plugin type with this name: GET /vco/api/catalog/<plugin>/<type>?conditions=name=<name>, answering link[] of attributes. VERIFY the plugin and type names on your release (GET /vco/api/catalog lists them).',
    resultType: 'boolean',
    params: [
      { name: 'host', type: 'string', description: 'Orchestrator host' },
      { name: 'auth', type: 'Any', description: 'Bearer header' },
      { name: 'safe', type: 'Any', description: 'http options' },
      { name: 'catalogPath', type: 'string', description: 'e.g. REST/RESTHost' },
      { name: 'objectName', type: 'string', description: 'The name to look for' },
    ],
    script: `var core = System.getModule("vcf.automation.core");\nvar mod = System.getModule(${q(packageName)});\n${String.raw`var r = core.http("GET", "https://" + host + "/vco/api/catalog/" + catalogPath + "?conditions=" + encodeURIComponent("name=" + objectName), auth, null, { redact: safe && safe.redact, allow: [404] });
if (r.statusCode === 404) throw new Error("The catalog has no " + catalogPath + "; is the plugin installed? (GET /vco/api/catalog lists the types.)");
var links = (r.body && r.body.link) || [];
for (var i = 0; i < links.length; i++) {
  var attrs = links[i].attributes || [];
  for (var j = 0; j < attrs.length; j++) if (attrs[j].name === "name" && String(attrs[j].value) === String(objectName)) return true;
}
return false;`}`,
  };
}

// ---------------------------------------------------------------------------
// Inventory endpoints

                        
                         
                                                                              
                            
                           
                               
                            
 

const ENDPOINTS                                         = {
  rest: { label: 'REST host', workflow: 'Add a REST host', catalog: 'REST/RESTHost', defaultPort: 443, requires: 'The HTTP-REST plugin (built in).' },
  powershell: { label: 'PowerShell host (WinRM)', workflow: 'Add a PowerShell host', catalog: 'PowerShell/PowerShellHost', defaultPort: 5986, requires: 'The PowerShell plugin, and WinRM listening on the host (HTTPS on 5986).' },
  ssh: { label: 'SSH host', workflow: 'Add SSH Host', catalog: 'SSH/SSHHost', defaultPort: 22, requires: 'The SSH plugin.' },
  ad: { label: 'Active Directory server', workflow: 'Add an Active Directory server', catalog: 'AD/AdHost', defaultPort: 636, requires: 'The Active Directory plugin.' },
  sql: { label: 'SQL database', workflow: 'Add a database', catalog: 'SQL/Database', defaultPort: 1433, requires: 'The SQL plugin, with the JDBC driver for the database type.' },
};

const DB_TYPES                                                                                                                     = {
  SQLServer: { label: 'Microsoft SQL Server', url: (h, p, d) => `jdbc:sqlserver://${h}:${p};databaseName=${d};encrypt=true`, port: 1433 },
  PostgreSQL: { label: 'PostgreSQL', url: (h, p, d) => `jdbc:postgresql://${h}:${p}/${d}?ssl=true&sslmode=verify-full`, port: 5432 },
  Oracle: { label: 'Oracle', url: (h, p, d) => `jdbc:oracle:thin:@//${h}:${p}/${d}`, port: 1521 },
  MySQL: { label: 'MySQL', url: (h, p, d) => `jdbc:mysql://${h}:${p}/${d}?sslMode=VERIFY_IDENTITY`, port: 3306 },
};

export const ORCHESTRATOR_ENDPOINT = automationBlueprint({
  id: 'vcfa_orchestrator_endpoint',
  platform: PLATFORM,
  label: 'An Orchestrator inventory endpoint (REST, PowerShell, SSH, AD, SQL)',
  group: 'Orchestrator',
  description:
    'The endpoint a workflow calls through, added to the Orchestrator inventory the way the plugin’s own "Add a …" library workflow does it — a REST host, a PowerShell (WinRM) host, an SSH host, an Active Directory server or a SQL database — with its account, session mode and TLS, run by a package that looks the endpoint up first and leaves an existing one alone. The password is a SecureString typed in after import.',
  inputs: [
    { id: 'kind', label: 'Endpoint', control: 'select', options: Object.entries(ENDPOINTS).map(([value, k]) => ({ value, label: k.label })), default: 'rest' },
    { id: 'endpoint_name', label: 'Name in the inventory', control: 'text', default: 'ipam-api' },
    { id: 'host', label: 'Host', control: 'text', default: 'ipam.example.com', hint: 'FQDN, IPv4 or IPv6 address' },
    { id: 'port', label: 'Port', control: 'number', default: 0, min: 0, max: 65535, hint: '0 uses the usual port for the kind' },
    { id: 'base_path', label: 'Base path', control: 'text', default: '/api', showWhen: { input: 'kind', equals: ['rest'] } },
    {
      id: 'rest_auth',
      label: 'Authentication',
      control: 'select',
      options: [
        { value: 'Basic', label: 'Basic' },
        { value: 'OAuth 2.0', label: 'OAuth 2.0 (token set on the host)' },
        { value: 'Digest', label: 'Digest' },
        { value: 'NTLM', label: 'NTLM' },
        { value: 'Kerberos', label: 'Kerberos' },
        { value: 'NONE', label: 'None' },
      ],
      default: 'Basic',
      showWhen: { input: 'kind', equals: ['rest'] },
    },
    {
      id: 'winrm_auth',
      label: 'Authentication',
      control: 'select',
      options: [
        { value: 'Kerberos', label: 'Kerberos' },
        { value: 'Basic', label: 'Basic' },
      ],
      default: 'Kerberos',
      showWhen: { input: 'kind', equals: ['powershell'] },
    },
    { id: 'use_tls', label: 'TLS (HTTPS, LDAPS, encrypted JDBC)', control: 'toggle', default: true, showWhen: { input: 'kind', notEquals: ['ssh'] } },
    { id: 'ssh_key', label: 'Log in with a key instead of a password', control: 'toggle', default: true, showWhen: { input: 'kind', equals: ['ssh'] } },
    { id: 'base_dn', label: 'Base DN', control: 'text', default: 'DC=example,DC=com', showWhen: { input: 'kind', equals: ['ad'] } },
    { id: 'db_type', label: 'Database', control: 'select', options: Object.entries(DB_TYPES).map(([value, d]) => ({ value, label: d.label })), default: 'SQLServer', showWhen: { input: 'kind', equals: ['sql'] } },
    { id: 'db_name', label: 'Database name', control: 'text', default: 'cmdb', showWhen: { input: 'kind', equals: ['sql'] } },
    { id: 'username', label: 'Account', control: 'text', default: 'svc-orchestrator', hint: 'The service account; its password is typed in after import' },
    {
      id: 'session_mode',
      label: 'Session',
      control: 'select',
      options: [
        { value: 'Shared Session', label: 'Shared — every run uses the account above' },
        { value: 'Per User Session', label: 'Per user — each run uses the caller’s own credentials' },
      ],
      default: 'Shared Session',
    },
  ],
  automation: (values                 , name        )             => {
    const kindId = str(values, 'kind', 'rest');
    const kind = ENDPOINTS[kindId] ?? ENDPOINTS['rest'] ;
    const endpointName = str(values, 'endpoint_name', '');
    const host = str(values, 'host', '').replace(/^\[|\]$/g, '');
    const dbType = str(values, 'db_type', 'SQLServer');
    const db = DB_TYPES[dbType] ?? DB_TYPES['SQLServer'] ;
    const port = num(values, 'port', 0) || (kindId === 'sql' ? db.port : kindId === 'ad' && !bool(values, 'use_tls', true) ? 389 : kindId === 'powershell' && !bool(values, 'use_tls', true) ? 5985 : kindId === 'rest' && !bool(values, 'use_tls', true) ? 80 : kind.defaultPort);
    const tls = kindId === 'ssh' ? true : bool(values, 'use_tls', true);
    const restAuth = str(values, 'rest_auth', 'Basic');
    const winrmAuth = str(values, 'winrm_auth', 'Kerberos');
    const sshKey = bool(values, 'ssh_key', true);
    const username = str(values, 'username', '');
    const shared = str(values, 'session_mode', 'Shared Session') === 'Shared Session';
    const base = slugOf(name || `${kindId}-${endpointName}`, 'endpoint');

    const findings            = [];
    if (!endpointName) findings.push(error('vcfa.endpoint.no-name', 'The endpoint has no name, which is how workflows find it.', { source: SRC }));
    if (!host || !hostOk(host)) findings.push(error('vcfa.endpoint.bad-host', `"${host}" is not a host name, IPv4 or IPv6 address.`, { source: SRC }));
    const url = kindId === 'rest' ? `${tls ? 'https' : 'http'}://${inUrl(host)}:${port}${str(values, 'base_path', '')}` : kindId === 'sql' ? db.url(inUrl(host), port, str(values, 'db_name', '')) : kindId === 'ad' ? `${tls ? 'ldaps' : 'ldap'}://${inUrl(host)}:${port}` : `${inUrl(host)}:${port}`;
    const cleartextAuth = (kindId === 'rest' && !tls && restAuth === 'Basic') || (kindId === 'powershell' && !tls && winrmAuth === 'Basic') || (kindId === 'ad' && !tls);
    if (cleartextAuth) {
      findings.push(error('vcfa.endpoint.cleartext', `${kind.label} with ${kindId === 'ad' ? 'a simple bind over plain LDAP' : 'Basic authentication over plain HTTP'} sends the account’s password in clear on every call.`, { remediation: 'Turn TLS on (and trust the certificate in SSL Trust Manager), or use Kerberos.', source: SRC }));
    } else if (kindId !== 'ssh' && !tls) {
      findings.push(warning('vcfa.endpoint.no-tls', `${kind.label} without TLS: whatever the workflows send and read crosses the network in clear.`, { source: SRC }));
    }
    if (!username && !(kindId === 'rest' && restAuth === 'NONE')) findings.push(error('vcfa.endpoint.no-account', 'No account is set, and the endpoint needs one.', { source: SRC }));
    if (/^(administrator|admin|root|sa|sys|system)(@|$)/i.test(username)) findings.push(warning('vcfa.endpoint.privileged-account', `"${username}" is a built-in administrator; every workflow using the endpoint gets all its rights.`, { remediation: 'A service account with only the rights the workflows need.', source: SRC }));
    if (!shared) findings.push(info('vcfa.endpoint.per-user', 'Per-user sessions need the caller’s own credentials: a scheduled or event-driven run has none, and fails.', { source: SRC }));
    if (kindId === 'ssh' && !sshKey) findings.push(warning('vcfa.endpoint.ssh-password', 'SSH by password: the host has to allow password logins, and the password sits in the Orchestrator inventory.', { remediation: 'Use a key pair: the private key stays in Orchestrator’s keystore, and the host allows only that key.', source: SRC }));

    // The library workflow's inputs (names VERIFY against the workflow on your release).
    const params                                        =
      kindId === 'rest'
        ? [['name', 'string', endpointName], ['url', 'string', url], ['authentication', 'string', restAuth], ['sessionMode', 'string', shared ? 'Shared Session' : 'Per User Session'], ['authUserName', 'string', username], ['connectionTimeout', 'number', '30'], ['operationTimeout', 'number', '60'], ['hostVerification', 'boolean', 'true']]
        : kindId === 'powershell'
          ? [['name', 'string', endpointName], ['host', 'string', host], ['port', 'number', String(port)], ['transportProtocol', 'string', tls ? 'HTTPS' : 'HTTP'], ['authentication', 'string', winrmAuth], ['sessionMode', 'string', shared ? 'Shared Session' : 'Per User Session'], ['userName', 'string', username]]
          : kindId === 'ssh'
            ? [['name', 'string', endpointName], ['hostname', 'string', host], ['port', 'number', String(port)], ['username', 'string', username], ['passwordAuthentication', 'boolean', String(!sshKey)], ['sessionMode', 'string', shared ? 'Shared Session' : 'Per User Session']]
            : kindId === 'ad'
              ? [['host', 'string', host], ['port', 'number', String(port)], ['baseDN', 'string', str(values, 'base_dn', '')], ['useSSL', 'boolean', String(tls)], ['useSharedSession', 'boolean', String(shared)], ['sharedUserName', 'string', username]]
              : [['name', 'string', endpointName], ['databaseType', 'string', dbType], ['connectionURL', 'string', url], ['sessionMode', 'string', shared ? 'Shared Session' : 'Per User Session'], ['userName', 'string', username]];
    const passwordParam = kindId === 'rest' ? 'authPassword' : kindId === 'ad' ? 'sharedUserPassword' : kindId === 'ssh' && sshKey ? '' : 'password';
    const request = { workflow: kind.workflow, catalog: kind.catalog, name: kindId === 'ad' ? host : endpointName, passwordParameter: passwordParam, parameters: params.map(([n, type, value]) => ({ name: n, type, value: vroValue(type, value) })) };

    const packageName = packageNameOf('vcfa', 'endpoint', base);
    const workflowName = elementName(`Add ${kind.label} ${endpointName || host}`);
    const pkg = toPackage({
      packageName,
      description: `Adds the ${kind.label} ${endpointName} to the Orchestrator inventory through the plugin’s library workflow.`,
      categoryPath: `Automation/Endpoints/${base}`,
      workflow: {
        name: workflowName,
        description: `Looks for the ${kind.label} "${request.name}" in the Orchestrator inventory; when it is not there, runs the library workflow "${kind.workflow}" with the settings of this package and waits for it. An existing one is left as it is. Set the dryRun input to true to preview without changing anything.`,
        inputs: [{ name: 'dryRun', type: 'boolean', description: 'true: report what would be added and change nothing' }],
        outputs: [{ name: 'summary', type: 'string', description: 'The audit record, JSON' }],
        script: [
          'var ctx = core.begin(settings, dryRun);',
          VCFA_LOGIN,
          String.raw`var req = JSON.parse(core.resource(RESOURCE_PATH, "endpoint.json"));
var vro = String(settings.vroHost || host);
if (req.passwordParameter) {
  if (!settings.endpointPassword) throw new Error("Set endpointPassword in the configuration element " + SETTINGS_NAME + ": the account's password (or leave the endpoint to per-user sessions).");
  req.parameters.push({ name: req.passwordParameter, type: "SecureString", value: { "secure-string": { value: String(settings.endpointPassword) } } });
}
var exists = mod.catalogHas(vro, auth, SAFE, req.catalog, req.name);
var runId = "";
if (exists) {
  System.log("Exists, left as it is: " + req.catalog + " \"" + req.name + "\". Change it with the library workflow \"Update …\", or remove it and run again.");
} else {
  var wfId = mod.workflowIdByName(vro, auth, SAFE, req.workflow);
  runId = core.act(ctx, "add " + req.catalog + " \"" + req.name + "\" with \"" + req.workflow + "\"", function () {
    return mod.runWorkflow(vro, auth, SAFE, wfId, req.parameters, 300);
  }) || "";
}
summary = core.audit(ctx, { endpoint: req.name, catalog: req.catalog, existed: exists, run: runId });
core.notify(settings.webhook, summary);`,
        ].join('\n'),
      },
      actions: [...vcfaActions(packageName), ...lookupActions(packageName), runWorkflowAction(packageName), catalogAction(packageName)],
      config: {
        name: 'Settings',
        description: `Settings of the ${workflowName} workflow. Fill vcfaApiToken${passwordParam ? ' and endpointPassword' : ''} after import; set dryRun to true to preview instead of changing anything.`,
        attributes: [
          ...vcfaSettings('vm-apps'),
          { name: 'vroHost', type: 'string', value: '', description: 'The Orchestrator host, when it is not the VCF Automation host' },
          ...(passwordParam ? [{ name: 'endpointPassword', type: 'SecureString'         , description: `The password of ${username || 'the account'}` }] : []),
          ...guardSettings(1, 'added'),
        ],
      },
      resources: [{ name: 'endpoint.json', content: json(request) }],
    });

    return {
      platform: PLATFORM,
      title: `${kind.label} ${endpointName || host} in the Orchestrator inventory — ${url}`,
      effect: 'reversible',
      trigger: { kind: 'manual', detail: 'Run once when the endpoint is set up, from the Orchestrator client or a pipeline', worstCase: 'once — an existing endpoint of the name is left alone' },
      scope: {
        what: `One ${kind.label} in the Orchestrator inventory, and through it whatever ${username || 'its account'} can reach on ${host}.`,
        decidedBy: [`The account ${username || '(none)'} and its rights on ${host} — the real upper bound for every workflow that uses the endpoint.`, shared ? 'Shared session: every workflow run uses that account, whoever started it.' : 'Per-user session: each run uses the caller’s own credentials.', 'Who may run workflows that use the endpoint (Orchestrator permissions on their folders).'],
        ifWrong: 'Every workflow bound to the endpoint acts with the account’s rights; an over-privileged account turns any of them into an administrator of the target.',
      },
      guardrails: [
        { rule: 'An existing endpoint of the name is left alone', because: 'Adding a second endpoint of the same name makes every workflow that looks it up by name ambiguous.' },
        ...(tls ? [{ rule: kindId === 'ssh' ? 'SSH, with the host key checked' : 'TLS on, certificate trusted in SSL Trust Manager', because: 'The password and the data are not sent in clear, and a man in the middle fails the handshake.' }] : []),
        { rule: 'The password is a SecureString typed in after import', because: 'It is never in a file, a package export or a log line.' },
      ],
      dryRun: [`Run the package workflow ${workflowName} with the dryRun input set to true: it looks the endpoint up in the inventory, logs "DRY RUN: would add …" and adds nothing.`],
      undo: [`Run the library workflow "${kind.workflow.replace(/^Add (an? )?/, 'Remove a ')}" (or delete it in the Inventory), after checking no workflow binds it — a workflow whose endpoint is gone fails at its first call.`],
      told: ['The run of the library workflow, in the Orchestrator client.', 'The audit record, posted to the webhook when one is set.'],
      requires: [PKG_REQUIRES, kind.requires, `${host}’s certificate trusted in Orchestrator (SSL Trust Manager → Import a certificate from URL)${kindId === 'ssh' ? ', or its host key accepted' : ''}.`, ...(kindId === 'ssh' && sshKey ? ['The Orchestrator public key (Library → SSH → Configuration → Generate key pair, then Register Orchestrator public key on host) in the account’s authorized_keys.'] : [])],
      files: {
        ...pkg.files,
        [`${base}-endpoint.json`]: json(request),
        'IMPORT.md': importMd({
          subject: `The ${kind.label} ${endpointName} (${url}) in the Orchestrator inventory. The Orchestrator package (\`${pkg.packageDir}\`) adds it: its workflow **${workflowName}** runs the plugin’s library workflow "${kind.workflow}" through the Orchestrator API and waits for it.`,
          orgs: 'VCF Automation 9.1 / 9.1.1 Orchestrator (VM Apps organization, or the Orchestrate tab of an All Apps organization), and VCF Operations orchestrator',
          steps: [
            ...packageSteps(pkg),
            manualStep('Or by hand', [`Library → Workflows → "${kind.workflow}", with the values in \`${base}-endpoint.json\` and the password typed in. The library workflow is the documented route; the package only runs it for you.`]),
          ],
          auth: ['import'],
          verify: [
            `The library workflow "${kind.workflow}", its input names (${params.map(([n]) => n).join(', ')}${passwordParam ? `, ${passwordParam}` : ''}) and the catalog type ${kind.catalog} are as the plugin ships them at 8.x; VERIFY them against the workflow and GET /vco/api/catalog on your release — a renamed input is ignored, not refused.`,
            'Running a workflow through POST /vco/api/workflows/{id}/executions and polling …/state is in the Orchestrator REST reference; the SecureString parameter form { "secure-string": { value } } is VERIFY.',
            VERIFY_LOGIN,
          ],
        }),
      },
      notes: [
        'Workflows find an endpoint by name or by binding it as an attribute. Keep the name stable: renaming it breaks every workflow that looked it up.',
        kindId === 'rest' ? 'A REST host carries its own authentication; the workflows that call it hold no credential.' : 'The password is stored encrypted in the Orchestrator inventory; rotate it with the plugin’s "Update …" workflow when the account’s password changes.',
      ],
      findings,
    };
  },
});

// ---------------------------------------------------------------------------
// Configuration elements, scheduled runs, package transfer

const ATTR_TYPES = ['string', 'number', 'boolean', 'SecureString', 'Array/string'];

export const ORCHESTRATOR_ASSETS = automationBlueprint({
  id: 'vcfa_orchestrator_assets',
  platform: PLATFORM,
  label: 'Orchestrator configuration elements, schedules and package moves',
  group: 'Orchestrator',
  description:
    'The Orchestrator assets around a workflow: a configuration element with its attributes (created, or the missing attributes added), a scheduled run of a workflow by name with its inputs, or a package moved from one Orchestrator to another — exported without secrets, the target’s current version kept first as the undo.',
  inputs: [
    {
      id: 'asset',
      label: 'Asset',
      control: 'select',
      options: [
        { value: 'config', label: 'A configuration element' },
        { value: 'schedule', label: 'A scheduled run of a workflow' },
        { value: 'transfer', label: 'A package moved to another Orchestrator' },
      ],
      default: 'config',
    },
    { id: 'config_path', label: 'Folder', control: 'text', default: 'Automation/Infrastructure', showWhen: { input: 'asset', equals: ['config'] } },
    { id: 'config_name', label: 'Element name', control: 'text', default: 'Settings', showWhen: { input: 'asset', equals: ['config'] } },
    { id: 'attributes', label: 'Attributes', control: 'textarea', default: 'allowedZones | string | example.com, lab.example.com | Zones the DNS workflows may write\ncap | number | 20 | Most changes one run may make\ndnsPassword | SecureString | - | Typed in after import', hint: 'Attribute | Type | Value | Description', showWhen: { input: 'asset', equals: ['config'] } },
    { id: 'overwrite', label: 'Set attributes that differ to these values', control: 'toggle', default: false, hint: 'Off adds missing ones and reports the rest', showWhen: { input: 'asset', equals: ['config'] } },
    { id: 'workflow_name', label: 'Workflow', control: 'text', default: 'Tag compliance report', hint: 'Exact name', showWhen: { input: 'asset', equals: ['schedule'] } },
    { id: 'recurrence', label: 'Runs', control: 'select', options: Object.entries(RECURRENCE).map(([value, r]) => ({ value, label: r.label })), default: 'daily', showWhen: { input: 'asset', equals: ['schedule'] } },
    { id: 'start', label: 'First run', control: 'text', default: '2026-10-01T06:00:00Z', hint: 'ISO 8601, UTC', showWhen: { input: 'asset', equals: ['schedule'] } },
    { id: 'timezone', label: 'Time zone', control: 'text', default: 'UTC', showWhen: { input: 'asset', equals: ['schedule'] } },
    { id: 'schedule_inputs', label: 'Inputs', control: 'textarea', default: 'dryRun | boolean | false', hint: 'Input | Type | Value', showWhen: { input: 'asset', equals: ['schedule'] } },
    { id: 'package_name', label: 'Package', control: 'text', default: 'vcf.automation.tags.compliance', showWhen: { input: 'asset', equals: ['transfer'] } },
    { id: 'include_values', label: 'Carry configuration values', control: 'toggle', default: false, hint: 'Never the SecureString ones', showWhen: { input: 'asset', equals: ['transfer'] } },
  ],
  automation: (values                 , name        )             => {
    const asset = str(values, 'asset', 'config');
    const findings            = [];

    if (asset === 'transfer') return transferPackage(values, name, findings);

    const isConfig = asset === 'config';
    const configPath = str(values, 'config_path', 'Automation');
    const configName = str(values, 'config_name', 'Settings');
    const overwrite = bool(values, 'overwrite', false);
    const attrs = rowsOf(str(values, 'attributes', ''), 4).flatMap(([key = '', type = '', value = '', description = '']) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
        findings.push(error('vcfa.config.bad-attribute', `Attribute "${key}" is not a configuration attribute name.`, { source: SRC }));
        return [];
      }
      const kind = ATTR_TYPES.includes(type) ? type : 'string';
      if (/password|secret|token|apikey|api_key/i.test(key) && kind !== 'SecureString') findings.push(error('vcfa.config.secret-not-secure', `Attribute ${key} looks like a secret and is not a SecureString.`, { remediation: 'Make it SecureString; it is created empty and typed in after import.', source: SRC }));
      if (kind === 'SecureString' && value) findings.push(error('vcfa.config.secret-value', `Attribute ${key} is a SecureString with a value on the page; secrets are typed into Orchestrator, never written into files.`, { source: SRC }));
      return [{ key, type: kind, value: kind === 'SecureString' ? null : kind === 'number' ? Number(value) : kind === 'boolean' ? /^(true|yes|1)$/i.test(value) : kind === 'Array/string' ? value.split(',').map((v) => v.trim()).filter(Boolean) : value, description }];
    });
    if (isConfig && attrs.length === 0) findings.push(error('vcfa.config.no-attributes', 'The element has no attributes.', { source: SRC }));
    if (isConfig && overwrite) findings.push(warning('vcfa.config.overwrite', 'Attributes that differ are set to the page’s values, replacing whatever an operator set since.', { remediation: 'Leave it off unless this file is the source of truth for the element.', source: SRC }));

    const workflowName = str(values, 'workflow_name', '');
    const recurrence = str(values, 'recurrence', 'daily');
    const start = str(values, 'start', '');
    const timezone = str(values, 'timezone', 'UTC') || 'UTC';
    const inputs = rowsOf(str(values, 'schedule_inputs', ''), 3).map(([n = '', type = '', value = '']) => [n, type || 'string', value]         );
    if (!isConfig) {
      if (!workflowName) findings.push(error('vcfa.schedule.no-workflow', 'Name the workflow to schedule.', { source: SRC }));
      if (Number.isNaN(new Date(start).getTime())) findings.push(error('vcfa.schedule.bad-start', `First run "${start}" is not an ISO 8601 date and time.`, { source: SRC }));
      if (inputs.some(([n, , v]) => n === 'dryRun' && /^false$/i.test(v))) findings.push(info('vcfa.schedule.acts', 'The scheduled runs pass dryRun false: they act.', { source: SRC }));
      if (inputs.some(([n, type]) => /password|secret|token/i.test(n) || type === 'SecureString')) findings.push(error('vcfa.schedule.secret-input', 'A scheduled run would store a secret input in the task, readable by anybody who can see the schedule.', { remediation: 'Let the workflow read the secret from its configuration element instead.', source: SRC }));
    }

    const base = slugOf(name || (isConfig ? `${configPath}-${configName}` : workflowName), isConfig ? 'config-element' : 'schedule');
    const task = scheduledTaskBody({ name: `${workflowName} — ${RECURRENCE[recurrence]?.label.toLowerCase() ?? recurrence}`, description: `Scheduled run of ${workflowName}.`, workflowId: '<looked up by name>', recurrence, start, timezone, params: inputs });
    const element = { categoryPath: configPath, name: configName, attributes: attrs, overwrite };

    const packageName = packageNameOf('vcfa', isConfig ? 'config' : 'schedule', base);
    const flowName = elementName(isConfig ? `Apply configuration ${configName}` : `Schedule ${workflowName}`);
    const pkg = toPackage({
      packageName,
      description: isConfig ? `The configuration element ${configPath}/${configName}, created or completed.` : `A scheduled run of ${workflowName}, ${RECURRENCE[recurrence]?.label.toLowerCase()}.`,
      categoryPath: `Automation/Assets/${base}`,
      workflow: {
        name: flowName,
        description: isConfig
          ? `Creates the configuration element ${configPath}/${configName} when it is missing and adds the attributes it lacks${overwrite ? ', and sets those that differ' : '; attributes that differ are reported and left'}. SecureString attributes are created empty. Set the dryRun input to true to preview without changing anything.`
          : `Finds the workflow "${workflowName}" by name and schedules it (${RECURRENCE[recurrence]?.label.toLowerCase()}, from ${start}) through the Orchestrator task API; a scheduled task of the same name is left as it is. Set the dryRun input to true to preview without changing anything.`,
        inputs: [{ name: 'dryRun', type: 'boolean', description: 'true: report what would change and change nothing' }],
        outputs: [{ name: 'summary', type: 'string', description: 'The audit record, JSON' }],
        script: isConfig
          ? [
              'var ctx = core.begin(settings, dryRun);',
              String.raw`var spec = JSON.parse(core.resource(RESOURCE_PATH, "element.json"));
var element = null;
var category = Server.getConfigurationElementCategoryWithPath(spec.categoryPath);
var all = category ? category.allConfigurationElements || [] : [];
for (var i = 0; i < all.length; i++) if (all[i].name === spec.name) element = all[i];
if (!element) {
  element = core.act(ctx, "create configuration element " + spec.categoryPath + "/" + spec.name, function () {
    // VERIFY: Server.createConfigurationElement(categoryPath, name) creates the folder path too.
    return Server.createConfigurationElement(spec.categoryPath, spec.name);
  });
}
var report = { added: [], set: [], differs: [] };
for (var a = 0; a < spec.attributes.length; a++) {
  var attr = spec.attributes[a];
  var current = element ? element.getAttributeWithKey(attr.key) : null;
  var wanted = attr.type === "SecureString" ? null : attr.value;
  if (!current) {
    report.added.push(attr.key);
    core.act(ctx, "add attribute " + attr.key + " (" + attr.type + ")" + (attr.type === "SecureString" ? ", empty: type it in" : ""), function () {
      // VERIFY: setAttributeWithKey(key, value, type) on your release.
      element.setAttributeWithKey(attr.key, wanted, attr.type);
      return true;
    });
  } else if (attr.type !== "SecureString" && JSON.stringify(current.value) !== JSON.stringify(wanted)) {
    if (spec.overwrite) {
      report.set.push(attr.key);
      core.act(ctx, "set attribute " + attr.key, function () { element.setAttributeWithKey(attr.key, wanted, attr.type); return true; });
    } else {
      report.differs.push(attr.key);
      System.warn("Differs, left as it is: " + attr.key + " (turn overwrite on to set it).");
    }
  }
}
summary = core.audit(ctx, report);
core.notify(settings.webhook, summary);`,
            ].join('\n')
          : [
              'var ctx = core.begin(settings, dryRun);',
              VCFA_LOGIN,
              String.raw`var vro = String(settings.vroHost || host);
var task = JSON.parse(core.resource(RESOURCE_PATH, "task.json"));
var tasks = core.http("GET", "https://" + vro + "/vco/api/tasks", auth, null, SAFE).body || {};
var links = tasks.link || [];
var existing = null;
for (var i = 0; i < links.length; i++) {
  var attrs = links[i].attributes || [];
  for (var j = 0; j < attrs.length; j++) if (attrs[j].name === "name" && String(attrs[j].value) === String(task.name)) existing = links[i];
}
if (existing) {
  System.log("Exists, left as it is: scheduled task \"" + task.name + "\". Delete it under Activity > Scheduled to change it.");
} else {
  task.workflow.id = mod.workflowIdByName(vro, auth, SAFE, settings.workflowName);
  core.act(ctx, "schedule \"" + settings.workflowName + "\" (" + task["recurrence-cycle"] + " from " + task["recurrence-start-date"] + ")", function () {
    return core.http("POST", "https://" + vro + "/vco/api/tasks", auth, task, SAFE);
  });
}
summary = core.audit(ctx, { task: task.name, existed: Boolean(existing) });
core.notify(settings.webhook, summary);`,
            ].join('\n'),
      },
      actions: isConfig ? [] : [...vcfaActions(packageName), ...lookupActions(packageName)],
      config: {
        name: 'Settings',
        description: `Settings of the ${flowName} workflow.${isConfig ? '' : ' Fill vcfaApiToken after import;'} Set dryRun to true to preview instead of changing anything.`,
        attributes: [
          ...(isConfig ? [] : [...vcfaSettings('vm-apps'), { name: 'vroHost', type: 'string'         , value: '', description: 'The Orchestrator host, when it is not the VCF Automation host' }, { name: 'workflowName', type: 'string'         , value: workflowName, description: 'The workflow to schedule, by exact name' }]),
          ...guardSettings(isConfig ? attrs.length + 1 : 1, isConfig ? 'created or set' : 'scheduled'),
        ],
      },
      resources: [isConfig ? { name: 'element.json', content: json(element) } : { name: 'task.json', content: json(task) }],
    });

    const common = {
      platform: PLATFORM,
      effect: 'reversible'         ,
      guardrails: [
        { rule: 'What exists is looked up first and left alone', because: isConfig ? 'An operator’s value is not replaced by a regenerated file unless overwrite says so.' : 'Running it twice does not schedule the workflow twice.' },
        ...(isConfig ? [{ rule: 'SecureString attributes are created empty', because: 'The secret is typed into Orchestrator, never carried in a file or an export.' }] : [{ rule: 'The workflow is found by exact name, refused when two match', because: 'A schedule on the wrong one of two same-named workflows runs the wrong thing every night.' }]),
      ],
      dryRun: [`Run the package workflow ${flowName} with the dryRun input set to true: it reads what exists, logs every "DRY RUN: would …" and changes nothing.`],
      told: ['The audit record of the run, posted to the webhook when one is set.', ...(isConfig ? [] : ['Activity → Scheduled in the Orchestrator client lists each scheduled run and its result.'])],
      findings,
    };

    if (isConfig) {
      return {
        ...common,
        title: `Configuration element ${configPath}/${configName} — ${attrs.length} attribute(s)`,
        trigger: { kind: 'manual', detail: 'Run once per environment when the element is set up, or from a pipeline', worstCase: `once — at most ${attrs.length + 1} change(s)` },
        scope: { what: `The configuration element ${configPath}/${configName} and nothing else.`, decidedBy: ['The folder and name.', `The attribute rows: ${attrs.map((a) => a.key).join(', ') || '(none)'}.`, overwrite ? 'Overwrite on: attributes that differ are set.' : 'Overwrite off: attributes that differ are reported only.'], ifWrong: 'Every workflow reading the element sees the new values on its next run; a wrong allow-list widens what they may touch.' },
        undo: ['Set the attributes back in Assets → Configurations (the audit record lists what was added and set), or delete the element when nothing reads it.'],
        requires: [PKG_REQUIRES],
        files: {
          ...pkg.files,
          [`${base}-element.json`]: json(element),
          'IMPORT.md': importMd({
            subject: `The configuration element ${configPath}/${configName}. The Orchestrator package (\`${pkg.packageDir}\`) creates it or adds what it lacks: workflow **${flowName}**.`,
            orgs: 'VCF Automation 9.1 / 9.1.1 Orchestrator, and VCF Operations orchestrator',
            steps: [...packageSteps(pkg), manualStep('Fill the secrets', [`Assets → Configurations → ${configPath} → ${configName}: type in the SecureString attributes (${attrs.filter((a) => a.type === 'SecureString').map((a) => a.key).join(', ') || 'none'}).`])],
            auth: ['import'],
            verify: ['Server.createConfigurationElement(categoryPath, name) and ConfigurationElement.setAttributeWithKey(key, value, type) are the Orchestrator scripting API calls for this; VERIFY their signatures in the API Explorer of your release.'],
          }),
        },
        notes: ['A package can carry a configuration element too, but importing it replaces the values operators set; this workflow completes an element in place instead.'],
      };
    }
    return {
      ...common,
      title: `${workflowName} — scheduled, ${RECURRENCE[recurrence]?.label.toLowerCase()} from ${start}`,
      trigger: { kind: 'schedule', detail: `${RECURRENCE[recurrence]?.label} from ${start} (${timezone})`, worstCase: `once per ${RECURRENCE[recurrence]?.label.toLowerCase().replace('every ', '') ?? 'run'}, unattended` },
      scope: { what: `Whatever "${workflowName}" touches, on every scheduled run.`, decidedBy: ['The workflow and its own scope.', `The inputs: ${inputs.map(([n, , v]) => `${n}=${v}`).join(', ') || '(none)'}.`, 'The rights of the account the schedule runs as — whoever created it.'], ifWrong: 'The workflow acts unattended at the scheduled time, every time, until somebody notices.' },
      undo: ['Delete or suspend the task under Activity → Scheduled (or DELETE /vco/api/tasks/{id}). Runs that already happened stay done.'],
      requires: [PKG_REQUIRES, `The workflow "${workflowName}" imported.`],
      files: {
        ...pkg.files,
        [`${base}-task.json`]: json(task),
        'IMPORT.md': importMd({
          subject: `A scheduled run of "${workflowName}". The Orchestrator package (\`${pkg.packageDir}\`) creates it: workflow **${flowName}** finds the workflow by name and posts the task.`,
          orgs: 'VCF Automation 9.1 / 9.1.1 Orchestrator, and VCF Operations orchestrator',
          steps: [...packageSteps(pkg), manualStep('Or by hand', [`Library → Workflows → ${workflowName} → Schedule, with the recurrence and inputs in \`${base}-task.json\`.`])],
          auth: ['import'],
          verify: ['The task body (start-mode, recurrence-cycle, recurrence-pattern, recurrence-start-date, input-parameters) follows the Orchestrator REST reference for /api/tasks; VERIFY against a task scheduled in the client (GET /vco/api/tasks/<id>).', VERIFY_LOGIN],
        }),
      },
      notes: ['The scheduled task runs as the user who created it — here, the account behind the API token. Use a service account’s token, or the schedule stops when that person leaves.'],
    };
  },
});

function transferPackage(values                 , name        , findings           )             {
  const packageName = str(values, 'package_name', '');
  const includeValues = bool(values, 'include_values', false);
  if (!/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(packageName)) findings.push(error('vcfa.package.bad-name', `"${packageName}" is not an Orchestrator package name (lower-case dotted words).`, { source: SRC }));
  if (includeValues) findings.push(warning('vcfa.package.values', 'Configuration values travel with the package, so the source environment’s hosts and allow-lists land on the target.', { remediation: 'Leave values behind and set them per environment; SecureString values never travel either way.', source: SRC }));
  const base = slugOf(name || packageName, 'package-transfer');
  const exportQuery = `exportConfigurationAttributeValues=${includeValues}&exportConfigSecureStringAttributeValues=false&exportGlobalTags=true&exportVersionHistory=true`;
  const importQuery = `overwrite=true&importConfigurationAttributeValues=${includeValues}&importConfigSecureStringAttributeValues=false&tagImportMode=ImportButPreserveExistingValue`;

  const login = (prefix        ) => [
    `  : "\${${prefix}_HOST:?set ${prefix}_HOST, the VCF Automation (or Orchestrator) host}"`,
    `  : "\${${prefix}_ORG:?set ${prefix}_ORG, the organization in its login URL}"`,
    `  : "\${${prefix}_API_TOKEN_FILE:?set ${prefix}_API_TOKEN_FILE to a mode-600 file holding an organization API token}"`,
    `  ${prefix}_HDR="$(umask 077; mktemp "\${TMPDIR:-/tmp}/auth.XXXXXX")"`,
    `  CLEAN+=("$${prefix}_HDR")`,
    `  ACCESS=$( { printf 'grant_type=refresh_token&refresh_token='; jq -jn --rawfile p "$${prefix}_API_TOKEN_FILE" '$p | rtrimstr("\\n") | @uri'; } |`,
    `    curl -sS -f -X POST "https://\${${prefix}_HOST}/oauth/tenant/\${${prefix}_ORG}/token" -H "Accept: application/json" -H "Content-Type: application/x-www-form-urlencoded" --data-binary @- | jq -r '.access_token')`,
    `  printf 'Authorization: Bearer %s\\n' "$ACCESS" > "$${prefix}_HDR"`,
    '  unset ACCESS',
  ];
  const script = [
    '#!/usr/bin/env bash',
    `# Move the Orchestrator package ${packageName} from one Orchestrator to another.`,
    '#',
    '# Exports it from SRC (no SecureString values; configuration values only when',
    '# chosen), keeps the TARGET’s current version as the undo, then imports it.',
    '# Applies when run; --dry-run exports both, lists what would change and imports',
    '# nothing. Tokens are read from files and sent from private header files.',
    'set -euo pipefail',
    '',
    'command -v jq >/dev/null || { echo "jq is required" >&2; exit 2; }',
    `PKG=${JSON.stringify(packageName)}`,
    'DRY_RUN=0',
    '[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=1',
    'CLEAN=()',
    'trap \'rm -f "${CLEAN[@]}"\' EXIT',
    'mkdir -p exports',
    'STAMP=$(date -u +%Y%m%dT%H%M%SZ)',
    '',
    'for side in SRC DST; do',
    '  if [[ $side == SRC ]]; then',
    ...login('SRC').map((l) => `  ${l}`),
    '  else',
    ...login('DST').map((l) => `  ${l}`),
    '  fi',
    'done',
    '',
    `echo "Exporting $PKG from $SRC_HOST"`,
    `curl -sS -f -H "@$SRC_HDR" -H "Accept: application/zip" "https://$SRC_HOST/vco/api/packages/$PKG/?${exportQuery}" -o "exports/$PKG-$STAMP.package"`,
    '',
    'echo "Keeping the target’s current version, if any, as the undo"',
    `if curl -sS -f -H "@$DST_HDR" -H "Accept: application/zip" "https://$DST_HOST/vco/api/packages/$PKG/?${exportQuery}" -o "exports/$PKG-$STAMP.target-before.package" 2>/dev/null; then`,
    '  echo "Saved exports/$PKG-$STAMP.target-before.package"',
    'else',
    '  rm -f "exports/$PKG-$STAMP.target-before.package"; echo "The target has no $PKG yet."',
    'fi',
    '',
    'if (( DRY_RUN )); then',
    '  echo "DRY RUN: would import exports/$PKG-$STAMP.package into $DST_HOST (overwrite, SecureString values untouched). Nothing was imported."',
    '  exit 0',
    'fi',
    '',
    `curl -sS -f -X POST -H "@$DST_HDR" -H "Accept: application/json" -F "file=@exports/$PKG-$STAMP.package" "https://$DST_HOST/vco/api/packages?${importQuery}"`,
    'echo',
    'echo "Imported $PKG into $DST_HOST. Undo: import exports/$PKG-$STAMP.target-before.package the same way."',
    '',
  ].join('\n');

  // The package half: a workflow that compares the package on the two sides,
  // so the move is checked from inside Orchestrator; the bytes move with the
  // script, because Orchestrator scripting cannot carry a binary package.
  const pkgName = packageNameOf('vcfa', 'transfer', base);
  const flowName = elementName(`Compare ${packageName}`);
  const pkg = toPackage({
    packageName: pkgName,
    description: `Compares the package ${packageName} on this Orchestrator and a target one.`,
    categoryPath: `Automation/Assets/${base}`,
    workflow: {
      name: flowName,
      description: `Reads the package ${packageName} on this Orchestrator and on the target (GET /vco/api/packages/<name>/ with Accept application/json) and reports their versions and whether a move is due. It changes nothing; scripts/transfer-package.sh moves the package.`,
      inputs: [{ name: 'dryRun', type: 'boolean', description: 'Kept for symmetry: this workflow only reads' }],
      outputs: [{ name: 'summary', type: 'string', description: 'The audit record, JSON' }],
      script: [
        `var PKG = ${q(packageName)};`,
        'var ctx = core.begin(settings, dryRun);',
        VCFA_LOGIN,
        String.raw`if (!settings.targetHost || !settings.targetApiToken) throw new Error("Set targetHost, targetOrg and targetApiToken in the configuration element " + SETTINGS_NAME + ".");
var targetAuth = core.loginVcfAutomation(String(settings.targetHost), settings.targetApiToken, settings.targetOrg || "");
function versionOn(h, a) {
  var r = core.http("GET", "https://" + h + "/vco/api/packages/" + PKG + "/", a, null, { redact: settings._secrets, allow: [404] });
  if (r.statusCode === 404) return null;
  var b = r.body || {};
  return String(b.version || b["package-version"] || "unknown");
}
var here = versionOn(String(settings.vroHost || host), auth);
var there = versionOn(String(settings.targetHost), targetAuth);
if (!here) throw new Error("No package " + PKG + " on this Orchestrator.");
System.log(PKG + ": here " + here + ", target " + (there || "(none)") + (here === there ? "; nothing to move." : "; run scripts/transfer-package.sh to move it."));
summary = core.audit(ctx, { package: PKG, source: here, target: there, due: here !== there });
core.notify(settings.webhook, summary);`,
      ].join('\n'),
    },
    config: {
      name: 'Settings',
      description: `Settings of the ${flowName} workflow. Fill vcfaApiToken and targetApiToken after import.`,
      attributes: [
        ...vcfaSettings('vm-apps'),
        { name: 'vroHost', type: 'string', value: '', description: 'This Orchestrator host, when it is not the VCF Automation host' },
        { name: 'targetHost', type: 'string', value: '', description: 'The target VCF Automation (or Orchestrator) host' },
        { name: 'targetOrg', type: 'string', value: '', description: 'The target organization' },
        { name: 'targetApiToken', type: 'SecureString', description: 'An API token of the target organization' },
        ...guardSettings(0, 'changed'),
      ]                        ,
    },
  });

  return {
    platform: PLATFORM,
    title: `Move the Orchestrator package ${packageName} between Orchestrators`,
    effect: 'reversible',
    trigger: { kind: 'manual', detail: 'Run when a package is promoted — by hand or from a pipeline', worstCase: 'once per run: one package replaced on the target' },
    scope: { what: `The package ${packageName} and every element in it (workflows, actions, configuration elements, resources) on the target Orchestrator.`, decidedBy: ['The package name.', 'What the package holds on the source at export time.', includeValues ? 'Configuration values travel (not SecureStrings).' : 'Configuration values stay behind; the target keeps its own.'], ifWrong: 'Every element of the package on the target is replaced by the source’s version, including workflows other people changed there since.' },
    guardrails: [
      { rule: 'The target’s current version is exported first', because: 'Re-importing it is the undo.' },
      { rule: 'SecureString values never travel', because: 'A secret moved in a package file is a secret in a file.' },
      { rule: 'Tag values on the target are kept', because: 'tagImportMode ImportButPreserveExistingValue imports tags without overwriting what the target set.' },
    ],
    dryRun: ['scripts/transfer-package.sh --dry-run exports from both sides and imports nothing.', `Run the package workflow ${flowName}: it compares the versions on both sides and changes nothing.`],
    undo: ['Import exports/<package>-<time>.target-before.package into the target the same way (curl -F file=@… POST /vco/api/packages?overwrite=true). Elements the new version added stay until deleted.'],
    told: ['The script’s output, and the exports folder it leaves behind.', 'The comparison workflow’s audit record, posted to the webhook when one is set.'],
    requires: [PKG_REQUIRES, 'curl, jq, and an organization API token for each side in a mode-600 file (SRC_API_TOKEN_FILE, DST_API_TOKEN_FILE).'],
    files: {
      ...pkg.files,
      'scripts/transfer-package.sh': underScripts(script),
      'IMPORT.md': importMd({
        subject: `Moving the Orchestrator package ${packageName}. The Orchestrator package (\`${pkg.packageDir}\`) holds the workflow **${flowName}** that compares both sides; \`scripts/transfer-package.sh\` moves the package itself, because Orchestrator scripting cannot carry a binary package between servers.`,
        orgs: 'VCF Automation 9.1 / 9.1.1 Orchestrator, and VCF Operations orchestrator (either side)',
        steps: [
          ...packageSteps(pkg),
          manualStep('Move it', [`\`SRC_HOST=… SRC_ORG=… SRC_API_TOKEN_FILE=… DST_HOST=… DST_ORG=… DST_API_TOKEN_FILE=… ./scripts/transfer-package.sh\` (\`--dry-run\` exports both sides and imports nothing). It exports from SRC, saves the target’s current version under exports/, and imports with overwrite.`]),
        ],
        auth: [],
        verify: [
          `Package export GET /vco/api/packages/{name}/ (Accept application/zip) and import POST /vco/api/packages (multipart file) are in the Orchestrator REST reference; the query options (${exportQuery.split('&').map((p) => p.split('=')[0]).join(', ')}; ${importQuery.split('&').map((p) => p.split('=')[0]).join(', ')}) are VERIFY on your release.`,
          VERIFY_LOGIN,
        ],
      }),
    },
    notes: ['Import the vcf.automation core library on the target before any package that needs it; this script moves one package at a time, so run it for the core library first when it is new there.'],
    findings,
  };
}

// ---------------------------------------------------------------------------
// Secrets and action constants

const SECRET_KINDS                                                                                                 = {
  secret: { label: 'Secret (templates read it as ${secret.name})', list: '/platform/api/secrets', create: '/platform/api/secrets' },
  'action-secret': { label: 'ABX action secret (encrypted)', list: '/abx/api/resources/action-secrets', create: '/abx/api/resources/action-secrets', encrypted: true },
  constant: { label: 'ABX action constant (not secret)', list: '/abx/api/resources/action-secrets', create: '/abx/api/resources/action-secrets', encrypted: false },
};

export const SECRETS = automationBlueprint({
  id: 'vcfa_secrets',
  platform: PLATFORM,
  label: 'Secrets and action constants',
  group: 'Extensibility',
  description:
    'The values templates and ABX actions read instead of carrying them: secrets (${secret.name} in a template, scoped to projects), encrypted ABX action secrets, and plain action constants. The values of secrets are typed into the package’s SecureString attributes after import, or read from files by the fallback script — never written here.',
  inputs: [
    {
      id: 'entries',
      label: 'Entries',
      control: 'textarea',
      default: 'dbAdminPassword | secret | - | Application Team A | Database admin password for the app templates\nipamApiKey | action-secret | - | - | Key the IPAM ABX actions use\nipamBaseUrl | constant | https://ipam.example.com | - | IPAM API base URL',
      hint: 'Name | Kind | Value | Projects | Description',
      help: 'Kind: secret, action-secret or constant. Value: constants only — secrets are typed in after import. Projects: comma-separated for a secret, "-" for the whole organization.',
    },
    { id: 'rotate', label: 'Replace the value of a secret that exists', control: 'toggle', default: false, hint: 'Off leaves existing ones as they are' },
  ],
  automation: (values                 , name        )             => {
    const findings            = [];
    const rotate = bool(values, 'rotate', false);
    const entries = rowsOf(str(values, 'entries', ''), 5).flatMap(([entryName = '', kindCell = '', value = '', projects = '', description = '']) => {
      const kind = kindCell.toLowerCase();
      if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(entryName)) {
        findings.push(error('vcfa.secret.bad-name', `"${entryName}" is not a name a template or action can refer to.`, { source: SRC }));
        return [];
      }
      if (!SECRET_KINDS[kind]) {
        findings.push(error('vcfa.secret.bad-kind', `${entryName}: kind "${kindCell}" is not secret, action-secret or constant.`, { source: SRC }));
        return [];
      }
      if (kind !== 'constant' && value) findings.push(error('vcfa.secret.value-on-page', `${entryName} is a ${kind} with its value on the page; it is typed into the package after import instead.`, { source: SRC }));
      if (kind === 'constant' && /password|secret|token|key/i.test(entryName)) findings.push(warning('vcfa.secret.constant-looks-secret', `${entryName} looks like a secret but is a plain constant, readable by every action author.`, { remediation: 'Make it an action-secret.', source: SRC }));
      if (kind !== 'secret' && projects) findings.push(info('vcfa.secret.projects-ignored', `${entryName}: action secrets and constants belong to the organization; the projects are ignored.`, { source: SRC }));
      return [{ name: entryName, kind, value: kind === 'constant' ? value : '', projects: kind === 'secret' ? projects.split(',').map((p) => p.trim()).filter(Boolean) : [], description, attribute: `value_${entryName.replace(/[^A-Za-z0-9_]/g, '_')}` }];
    });
    const names = entries.map((e) => e.name);
    for (const dup of new Set(names.filter((n, i) => names.indexOf(n) !== i))) findings.push(error('vcfa.secret.duplicate', `${dup} is listed twice.`, { source: SRC }));
    if (entries.length === 0) findings.push(error('vcfa.secret.none', 'No entries.', { source: SRC }));
    if (rotate) findings.push(warning('vcfa.secret.rotate', 'Existing secrets get the value typed into the package; every template and action using them sees it on its next run.', { source: SRC }));
    const hidden = entries.filter((e) => e.kind !== 'constant');
    const base = slugOf(name || 'secrets', 'secrets');
    const spec = entries.map(({ attribute, value, ...rest }) => ({ ...rest, attribute, ...(rest.kind === 'constant' ? { value } : {}) }));

    const packageName = packageNameOf('vcfa', 'secrets', base);
    const flowName = elementName(`Apply secrets ${base}`);
    const pkg = toPackage({
      packageName,
      description: `${entries.length} secret(s) and action constant(s) in VCF Automation.`,
      categoryPath: `Automation/Secrets/${base}`,
      workflow: {
        name: flowName,
        description: `Creates the secrets, ABX action secrets and constants listed in the package that do not exist${rotate ? ', and replaces the value of secrets that do' : '; existing ones are left as they are'}. Values of secrets come from the SecureString attributes of the configuration element. Set the dryRun input to true to preview without changing anything.`,
        inputs: [{ name: 'dryRun', type: 'boolean', description: 'true: report what would change and change nothing' }],
        outputs: [{ name: 'summary', type: 'string', description: 'The audit record, JSON' }],
        script: [
          `var ROTATE = ${rotate};`,
          'var ctx = core.begin(settings, dryRun);',
          VCFA_LOGIN,
          String.raw`var entries = JSON.parse(core.resource(RESOURCE_PATH, "entries.json"));
for (var c = 0; c < entries.length; c++) {
  if (entries[c].kind !== "constant" && !settings[entries[c].attribute]) throw new Error("Set " + entries[c].attribute + " in the configuration element " + SETTINGS_NAME + ": the value of " + entries[c].name + ". Nothing was changed.");
}
var projects = mod.listAll(host, auth, "/iaas/api/projects", SAFE);
if (projects.length === 0) throw new Error("No project visible to this token; the organization id is read from one.");
var orgId = String(projects[0].orgId || "");
function projectIds(namesWanted) {
  var ids = [];
  for (var i = 0; i < namesWanted.length; i++) {
    var p = mod.findOne(projects, { name: namesWanted[i] }, "project named " + namesWanted[i]);
    if (!p) throw new Error("No project named '" + namesWanted[i] + "'.");
    ids.push(String(p.id));
  }
  return ids;
}
var secretsNow = mod.listAll(host, auth, "/platform/api/secrets", SAFE);
var actionSecretsNow = mod.listAll(host, auth, "/abx/api/resources/action-secrets", SAFE);
var done = [];
for (var e = 0; e < entries.length; e++) {
  var entry = entries[e];
  var isSecret = entry.kind === "secret";
  var found = mod.findOne(isSecret ? secretsNow : actionSecretsNow, { name: entry.name }, entry.kind + " named " + entry.name);
  var value = entry.kind === "constant" ? String(entry.value) : String(settings[entry.attribute]);
  if (found && !(ROTATE && entry.kind !== "constant") && !(entry.kind === "constant" && String(found.value) !== value)) {
    System.log("Exists, left as it is: " + entry.kind + " " + entry.name);
    continue;
  }
  var body = isSecret
    ? { name: entry.name, description: entry.description, value: value, projectIds: projectIds(entry.projects), orgScoped: entry.projects.length === 0 }
    : { name: entry.name, description: entry.description, value: value, encrypted: entry.kind === "action-secret", orgId: orgId };
  var path = isSecret ? "/platform/api/secrets" : "/abx/api/resources/action-secrets";
  core.act(ctx, (found ? "replace the value of " : "create ") + entry.kind + " " + entry.name, function () {
    return found ? core.http(isSecret ? "PATCH" : "PUT", "https://" + host + path + "/" + found.id, auth, body, SAFE) : core.http("POST", "https://" + host + path, auth, body, SAFE);
  });
  done.push(entry.name);
}
summary = core.audit(ctx, { changed: done });
core.notify(settings.webhook, summary);`,
        ].join('\n'),
      },
      actions: vcfaActions(packageName),
      config: {
        name: 'Settings',
        description: `Settings of the ${flowName} workflow. Fill vcfaApiToken${hidden.length > 0 ? ` and ${hidden.map((e) => e.attribute).join(', ')}` : ''} after import; set dryRun to true to preview instead of changing anything.`,
        attributes: [
          ...vcfaSettings('vm-apps'),
          ...hidden.map((e)                     => ({ name: e.attribute, type: 'SecureString', description: `The value of ${e.kind} ${e.name}` })),
          ...guardSettings(entries.length, 'created or replaced'),
        ],
      },
      resources: [{ name: 'entries.json', content: json(spec) }],
    });

    // The fallback: each value from a mode-600 file named by an environment
    // variable, built into the body with jq and sent on stdin.
    const envOf = (entryName        ) => `VALUE_${entryName.replace(/[^A-Za-z0-9]/g, '_').toUpperCase()}_FILE`;
    const script = [
      '#!/usr/bin/env bash',
      '# Create the secrets, ABX action secrets and constants in VCF Automation.',
      '#',
      '# The value of each secret is read from a mode-600 file named by its',
      '# VALUE_<NAME>_FILE variable and sent on stdin; nothing here holds one.',
      '# Applies when run; --dry-run only says what it would create.',
      'set -euo pipefail',
      '',
      ...authPreamble('vcf-automation'),
      '',
      'command -v jq >/dev/null || { echo "jq is required" >&2; exit 2; }',
      'DRY_RUN=0',
      '[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=1',
      ...(entries.some((e) => e.kind !== 'secret') ? [': "${VCFA_ORG_ID:?set VCFA_ORG_ID, the organization id (GET /iaas/api/projects shows it as orgId)}"'] : []),
      '',
      'send() {',
      '  local path="$1" what="$2"',
      '  if (( DRY_RUN )); then echo "DRY RUN: would create $what"; cat >/dev/null; return 0; fi',
      '  echo "POST $path ($what)"',
      `  curl -sS -f -X POST "https://\${VCFA_HOST}$path" -H "${authHeader('vcf-automation')}" -H "Accept: application/json" -H "Content-Type: application/json" --data-binary @-`,
      '  echo',
      '}',
      '',
      ...entries.flatMap((e) =>
        e.kind === 'constant'
          ? [`jq -n --arg n ${JSON.stringify(e.name)} --arg d ${JSON.stringify(e.description)} --arg v ${JSON.stringify(e.value)} --arg o "$VCFA_ORG_ID" '{name: $n, description: $d, value: $v, encrypted: false, orgId: $o}' | send /abx/api/resources/action-secrets ${JSON.stringify(`constant ${e.name}`)}`]
          : [
              `: "\${${envOf(e.name)}:?set ${envOf(e.name)} to a mode-600 file holding the value of ${e.name}}"`,
              e.kind === 'secret'
                ? [
                    ...(e.projects.length > 0 ? [`: "\${${envOf(e.name).replace(/^VALUE_/, 'PROJECT_IDS_').replace(/_FILE$/, '')}:?set ${envOf(e.name).replace(/^VALUE_/, 'PROJECT_IDS_').replace(/_FILE$/, '')} to the ids of ${e.projects.join(', ')}, comma separated (GET /iaas/api/projects)}"`] : []),
                    `jq -n --arg n ${JSON.stringify(e.name)} --arg d ${JSON.stringify(e.description)} --rawfile v "$${envOf(e.name)}" ${e.projects.length > 0 ? `--arg p "$${envOf(e.name).replace(/^VALUE_/, 'PROJECT_IDS_').replace(/_FILE$/, '')}" ` : ''}'{name: $n, description: $d, value: ($v | rtrimstr("\\n")), projectIds: ${e.projects.length > 0 ? '($p | split(",") | map(select(. != "")))' : '[]'}, orgScoped: ${e.projects.length === 0}}' | send /platform/api/secrets ${JSON.stringify(`secret ${e.name}`)}`,
                  ].join('\n')
                : `jq -n --arg n ${JSON.stringify(e.name)} --arg d ${JSON.stringify(e.description)} --rawfile v "$${envOf(e.name)}" --arg o "$VCFA_ORG_ID" '{name: $n, description: $d, value: ($v | rtrimstr("\\n")), encrypted: true, orgId: $o}' | send /abx/api/resources/action-secrets ${JSON.stringify(`action secret ${e.name}`)}`,
            ],
      ),
      '',
      'if (( DRY_RUN )); then echo "Dry run: nothing was changed. Run it without --dry-run to apply."; fi',
      '# Undo: DELETE /platform/api/secrets/{id} or /abx/api/resources/action-secrets/{id} — after checking nothing reads it.',
      '',
    ].join('\n');

    return {
      platform: PLATFORM,
      title: `${entries.length} secret(s) and action constant(s)`,
      effect: 'reversible',
      trigger: { kind: 'manual', detail: 'Run when the values are set up or rotated, by hand or from a pipeline', worstCase: `once — ${entries.length} change(s) at most` },
      scope: {
        what: `The entries ${names.join(', ')} in the VCF Automation organization${entries.some((e) => e.projects.length > 0) ? ', secrets scoped to their projects' : ''}.`,
        decidedBy: ['The entry names — templates and actions refer to them by name.', 'For a secret, its projects (or the whole organization).', 'For an action secret or constant, the whole organization: every ABX action may read it.'],
        ifWrong: 'A secret scoped to the whole organization is readable by every template of every project; a constant holding a secret is readable by every action author.',
      },
      guardrails: [
        { rule: 'Secret values come from SecureString attributes or files, never from these files', because: 'A secret written into a generated file ends up in a repository.' },
        { rule: 'Every secret value is checked before the first write', because: 'A half-applied set of secrets breaks the templates that read the missing ones.' },
        { rule: rotate ? 'Rotation is explicit' : 'Existing secrets are left as they are', because: 'Replacing a value changes every deployment and action that reads it on its next run.' },
      ],
      dryRun: [`Run the package workflow ${flowName} with the dryRun input set to true: it reads what exists, logs every "DRY RUN: would create …" and changes nothing.`, 'Or scripts/apply-secrets.sh --dry-run.'],
      undo: ['DELETE /platform/api/secrets/{id} (Infrastructure → Secrets) or /abx/api/resources/action-secrets/{id} (Extensibility → Library → Action Constants) — after checking no template or action still reads it. A replaced value is not kept: rotate back by typing the old one in.'],
      told: ['The audit record of the run, posted to the webhook when one is set.'],
      requires: [PKG_REQUIRES, 'An organization administrator token (secrets and action constants are organization objects).'],
      files: {
        ...pkg.files,
        [`${base}-entries.json`]: json(spec),
        'scripts/apply-secrets.sh': underScripts(script),
        'IMPORT.md': importMd({
          subject: `${entries.length} secret(s) and action constant(s). The Orchestrator package (\`${pkg.packageDir}\`) applies them: workflow **${flowName}**, with each secret’s value typed into its SecureString attribute. \`scripts/apply-secrets.sh\` does the same from value files.`,
          steps: [
            ...packageSteps(pkg),
            manualStep('Or by hand: scripts/apply-secrets.sh', [`Put each value in a mode-600 file and name it in ${hidden.map((e) => envOf(e.name)).join(', ') || 'nothing (no secrets)'}; run \`./scripts/apply-secrets.sh\` (\`--dry-run\` first). In the interface: Infrastructure → Secrets, and Extensibility → Library → Action Constants.`]),
            manualStep('Use them', ['In a template: `${secret.<name>}` (the input or property stays encrypted). In an ABX action: add the constant or secret under the action’s inputs; it arrives in `inputs` like any other.']),
          ],
          auth: ['apply'],
          verify: [
            'Secrets: /platform/api/secrets with name, value, projectIds and orgScoped is the 8.x Secrets API that VM Apps organizations keep; VERIFY on 9.1 with GET of one made under Infrastructure → Secrets. The update verb (PATCH) is VERIFY.',
            'Action secrets and constants: /abx/api/resources/action-secrets with name, value, encrypted and orgId; VERIFY the path and the update verb (PUT) against the ABX API reference of your release.',
            VERIFY_LOGIN,
          ],
        }),
      },
      notes: ['A secret changed here is read by deployments on their next request or day-2 action; running deployments keep the value they resolved.'],
      findings,
    };
  },
});
