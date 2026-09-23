/**
 * VCF Operations: setting it up.
 *
 * Before any alert or automation means anything, VCF Operations has to be
 * collecting from the right places, able to tell somebody, and giving the right
 * people the right view. Three things, and each has a way of going wrong that
 * nobody notices until an incident: an adapter on an administrator's personal
 * account that stops when they leave, an outbound plugin that has never sent a
 * message, a role granted on the whole estate because scoping it was fiddly.
 */

import { bool, str,                      } from '../../kit/blueprint.js';
import { error, warning,              } from '../../core/findings.js';
import { automationBlueprint,                          } from '../from-automation.js';
import { listOf, slugOf,                 } from '../automation.js';
import { applyScript, authHeader, authPreamble } from '../apply.js';
import { importMd } from '../vcfops-import.js';
import { OPS_PACKAGE_REQUIRES, inScripts, opsPackage, opsPart, packageSteps } from './vcf-operations-content.js';

const PLATFORM = 'vcf-operations'         ;
const SRC = 'ArchToolKit';
const API_REF = 'VCF Operations API 9.x: https://developer.broadcom.com/xapis/vcf-operations-api/latest/';

/**
 * Adapter instance, 9.x: a vCenter is added as an integration (POST
 * /api/integrations/vcenters — the 9.x reference sends vCenter and VCF cloud
 * accounts there rather than to POST /api/adapters), with a credential made
 * first. The vCenter certificate is accepted only when its thumbprint is the
 * one in the settings: the reference answers an untrusted certificate with
 * HTTP 400 and the certificates, and takes them back in "certificates".
 */
const ADAPTER_BODY = String.raw`if (!settings.vcenter) throw new Error("Set vcenter in the configuration element " + SETTINGS_NAME + ".");
function scrub(text) {
  var out = String(text || "").substring(0, 300);
  var secrets = settings._secrets || [];
  for (var i = 0; i < secrets.length; i++) if (secrets[i]) out = out.split(secrets[i]).join("****");
  return out;
}
function thumb(text) { return String(text || "").toUpperCase().replace(/[^0-9A-F]/g, ""); }
// Every object carrying a thumbprint, wherever the 400 response puts it.
function certificatesIn(node, out) {
  if (!node || typeof node !== "object") return;
  if (typeof node.thumbprint === "string" && node.thumbprint) { out.push(node); return; }
  for (var k in node) if (node.hasOwnProperty(k)) certificatesIn(node[k], out);
}
function identifier(item, key) {
  var list = (item.resourceKey && item.resourceKey.resourceIdentifiers) || item.resourceIdentifiers || [];
  for (var i = 0; i < list.length; i++) {
    var name = list[i].identifierType ? list[i].identifierType.name : list[i].name;
    if (String(name) === key) return String(list[i].value);
  }
  return null;
}
var credential = JSON.parse(core.resource(RESOURCE_PATH, "credential.json"));
var integration = JSON.parse(core.resource(RESOURCE_PATH, "integration.json"));
var group = named(listAll("collectorgroups", "collectorGroups"), settings.collectorGroup);
if (!group) throw new Error("No collector group named \"" + settings.collectorGroup + "\" (GET collectorgroups).");
integration.collectorGroupId = String(group.id);
var adapters = listAll("adapters?adapterKindKey=VMWARE", "adapterInstancesInfoDto");
var found = null;
for (var a = 0; a < adapters.length; a++) {
  if (String((adapters[a].resourceKey || {}).name) === String(settings.vcenter) || identifier(adapters[a], "VCURL") === String(settings.vcenter)) found = adapters[a];
}
var adapterId = null;
if (found) {
  adapterId = String(found.id);
  System.log("Exists, left as it is: the vCenter adapter instance for " + settings.vcenter + " (" + adapterId + ")");
} else {
  var credId = null;
  var existingCred = named(listAll("credentials?adapterKind=VMWARE", "credentialInstances"), credential.name);
  if (existingCred) {
    credId = String(existingCred.id);
    System.log("Exists, used as it is (its password is not changed): the credential \"" + credential.name + "\" (" + credId + ")");
  } else {
    if (!settings.vcenterPassword) throw new Error("Set vcenterPassword in the configuration element " + SETTINGS_NAME + ".");
    for (var f = 0; f < credential.fields.length; f++) {
      if (credential.fields[f].name === "USER") credential.fields[f].value = String(settings.vcenterUsername);
      if (credential.fields[f].name === "PASSWORD") credential.fields[f].value = String(settings.vcenterPassword);
    }
    credId = core.act(ctx, "create the credential \"" + credential.name + "\"", function () {
      var r = ops("POST", "credentials", credential, null, null);
      if (!r.body || !r.body.id) throw new Error("POST credentials returned no id.");
      return String(r.body.id);
    });
  }
  integration.credentialInstanceId = credId || "new-credential";
  adapterId = core.act(ctx, "create the vCenter integration for " + settings.vcenter, function () {
    var r = ops("POST", "integrations/vcenters", integration, { allow: [400] }, null);
    if (r.statusCode === 400) {
      var offered = [];
      certificatesIn(r.body, offered);
      if (!offered.length) throw new Error("POST integrations/vcenters returned HTTP 400: " + scrub(r.text));
      var prints = [];
      var accepted = [];
      for (var c = 0; c < offered.length; c++) {
        prints.push(String(offered[c].thumbprint));
        if (thumb(settings.vcenterThumbprint) && thumb(offered[c].thumbprint) === thumb(settings.vcenterThumbprint)) accepted.push(offered[c]);
      }
      if (!thumb(settings.vcenterThumbprint)) throw new Error("vCenter " + settings.vcenter + " presented the certificate(s) " + prints.join(", ") + ". Check the thumbprint on the vCenter itself, set vcenterThumbprint to it, and run again.");
      if (!accepted.length) throw new Error("The certificate(s) " + prints.join(", ") + " presented for " + settings.vcenter + " do not match vcenterThumbprint; nothing was accepted.");
      integration.certificates = accepted;
      r = ops("POST", "integrations/vcenters", integration, null, null);
    }
    if (!r.body || !r.body.id) throw new Error("POST integrations/vcenters returned no id.");
    return String(r.body.id);
  });
  if (settings.startCollection === true || String(settings.startCollection) === "true") {
    core.act(ctx, "start collection on " + settings.vcenter, function () {
      return ops("PUT", "adapters/" + q(adapterId) + "/monitoringstate/start", null, null, null).statusCode;
    });
  }
}`;

/** Outbound plugin: created once, by name; a new one is tested, and enabled only when the test passed. */
const OUTBOUND_BODY = String.raw`var plugin = JSON.parse(core.resource(RESOURCE_PATH, "plugin.json"));
var existing = named(listAll("alertplugins?pluginTypeId=" + q(plugin.pluginTypeId), "notificationPluginInstances"), plugin.name);
var pluginRef = null;
if (existing) {
  pluginRef = String(existing.pluginId);
  System.log("Exists, left as it is: outbound instance \"" + plugin.name + "\" (" + pluginRef + ")");
} else {
  pluginRef = core.act(ctx, "create outbound instance \"" + plugin.name + "\"", function () {
    var r = ops("POST", "alertplugins", plugin, null, null);
    var made = r.body && (r.body.pluginId || r.body.id);
    if (!made) throw new Error("POST alertplugins returned no pluginId.");
    return String(made);
  });
  if (settings.testAndEnable === true || String(settings.testAndEnable) === "true") {
    core.act(ctx, "test outbound instance \"" + plugin.name + "\"", function () {
      return ops("POST", "alertplugins/" + q(pluginRef) + "/test", null, null, null).statusCode;
    });
    core.act(ctx, "enable outbound instance \"" + plugin.name + "\"", function () {
      return ops("PUT", "alertplugins/" + q(pluginRef) + "/enable/true", null, null, null).statusCode;
    });
  } else {
    System.log("Left disabled: test it (POST alertplugins/{id}/test, or Test in the interface) and enable it by hand.");
  }
}`;

/**
 * Access: the authentication source and the group by name; the traversal spec
 * for custom groups and the custom groups by name, so the grant names ids that
 * exist. A user group that is already there is left alone.
 */
const ACCESS_BODY = String.raw`var grant = JSON.parse(core.resource(RESOURCE_PATH, "usergroup.json"));
var source = named(listAll("auth/sources", "sources"), settings.authSource);
if (!source) throw new Error("No authentication source named \"" + settings.authSource + "\" (GET auth/sources).");
grant.authSourceId = String(source.id);
var existing = named(listAll("auth/usergroups", "userGroups"), grant.name);
var groupRef = null;
if (existing) {
  groupRef = String(existing.id);
  System.log("Exists, left as it is: user group \"" + grant.name + "\" (" + groupRef + "). Its roles are not changed: compare GET auth/usergroups/" + groupRef + "/permissions with this grant.");
} else {
  var scope = settings.scopeGroups || [];
  if (scope.length) {
    var specs = listAll("auth/traversalspecs?adapterKind=Container&resourceKind=Environment", "specs");
    var spec = settings.traversalSpecName ? named(specs, settings.traversalSpecName) : (specs.length === 1 ? specs[0] : null);
    if (!spec) throw new Error((settings.traversalSpecName ? "No traversal spec named \"" + settings.traversalSpecName + "\"" : specs.length + " traversal specs for custom groups") + "; set traversalSpecName to the one to use (GET auth/traversalspecs).");
    var customGroups = listAll("resources/groups", "groups");
    var ids = [];
    for (var i = 0; i < scope.length; i++) {
      var hit = named(customGroups, scope[i], "resourceKey.name");
      if (!hit) throw new Error("No custom group named \"" + scope[i] + "\"; nothing was granted.");
      ids.push(String(hit.id));
    }
    var instance = grant["role-permissions"][0]["traversal-spec-instances"][0];
    instance.name = String(spec.name);
    instance.resourceSelection[0].resourceId = ids;
  }
  groupRef = core.act(ctx, "import user group \"" + grant.name + "\" as " + grant["role-permissions"][0].roleName + (scope.length ? " on " + scope.join(", ") : " on every object"), function () {
    var r = ops("POST", "auth/usergroups", grant, null, null);
    if (!r.body || !r.body.id) throw new Error("POST auth/usergroups returned no id.");
    return String(r.body.id);
  });
}`;

export const VCF_OPERATIONS_SETUP                                 = [
  // -------------------------------------------------------------------------
  automationBlueprint({
    id: 'vcfops_adapter_instance',
    platform: PLATFORM,
    label: 'Collect from a vCenter',
    group: 'Setup',
    description:
      'A vCenter adapter instance on a named collector group, with its credential created separately and read from the environment at apply time. Written with a service account in mind, because the commonest reason an estate goes quiet in VCF Operations is an adapter running on somebody’s personal login.',
    inputs: [
      { id: 'vcenter', label: 'vCenter', control: 'text', default: 'vcenter01.example.com' },
      { id: 'account', label: 'Service account', control: 'text', default: 'svc-vcfops-collect@vsphere.local', hint: 'Read-only, plus the action rights if you will run actions' },
      { id: 'collector_group', label: 'Collector group', control: 'text', default: 'Site A collectors' },
      { id: 'actions', label: 'Enable actions on this vCenter', control: 'toggle', default: false },
    ],
    automation: (values                 , name        )             => {
      const vcenter = str(values, 'vcenter', '');
      const account = str(values, 'account', '');
      const group = str(values, 'collector_group', '');
      const actions = bool(values, 'actions', false);
      const base = slugOf(name || vcenter, 'adapter');

      const findings            = [];
      if (/^administrator@|^root$|^admin/i.test(account)) {
        findings.push(
          error('vcfops.adapter.admin-account', `${account} is a built-in administrator.`, {
            remediation: 'Create a service account with read-only rights (and the action rights, if needed). An administrator credential in a monitoring tool is the widest credential in the estate held by the least-watched system.',
            source: SRC,
          }),
        );
      } else if (!/svc|service|srv|collect/i.test(account)) {
        findings.push(
          warning('vcfops.adapter.personal', `${account} does not look like a service account.`, {
            remediation: 'When a person leaves, their account is disabled and collection stops. Nothing in VCF Operations alerts on that loudly — see the self-check in this kit.',
            source: SRC,
          }),
        );
      }
      if (!group.trim()) {
        findings.push(warning('vcfops.adapter.no-group', 'No collector group, so the adapter lands on whichever collector is chosen for it and cannot fail over.', { source: SRC }));
      }

      const credential = {
        name: `${vcenter} — ${account}`,
        adapterKindKey: 'VMWARE',
        credentialKindKey: 'PRINCIPALCREDENTIAL',
        fields: [
          { name: 'USER', value: account },
          { name: 'PASSWORD', value: '__FROM_ENVIRONMENT__' },
        ],
      };
      // 9.x: a vCenter is added through POST /api/integrations/vcenters (the
      // reference sends vCenter cloud accounts there, not to POST /api/adapters),
      // with the credential by id and the collector group by id.
      const integration = {
        name: vcenter,
        description: 'Generated by ArchToolKit.',
        collectorGroupId: '__COLLECTOR_GROUP_ID__',
        resourceIdentifiers: [
          { name: 'VCURL', value: vcenter },
          { name: 'AUTODISCOVERY', value: 'true' },
          { name: 'PROCESSCHANGEEVENTS', value: 'true' },
        ],
        credentialInstanceId: '__CREDENTIAL_ID__',
      };
      const pkg = opsPackage({
        parts: ['adapter', base],
        folder: `adapter-${base}`,
        description: `Adds ${vcenter} to VCF Operations as a vCenter integration on the collector group "${group}", with its credential, once.`,
        workflowName: `Collect from ${opsPart(base)}`,
        workflowDescription: `Creates the credential (unless one of that name exists) and the vCenter integration for ${vcenter} on "${group}" (unless an adapter instance for it exists), accepting the vCenter certificate only when its thumbprint is vcenterThumbprint, then starts collection.`,
        changes: true,
        cap: 3,
        outputs: [{ name: 'adapterInstanceId', type: 'string', description: 'The adapter instance id, empty in a dry run' }],
        account: 'An account that may add integrations and credentials',
        settings: [
          { name: 'vcenter', type: 'string', value: vcenter, description: 'The vCenter, as VCF Operations should reach it' },
          { name: 'vcenterUsername', type: 'string', value: account, description: 'The service account VCF Operations collects as' },
          { name: 'vcenterPassword', type: 'SecureString', description: 'Its password' },
          { name: 'vcenterThumbprint', type: 'string', value: '', description: 'The SHA thumbprint of the vCenter certificate, read on the vCenter itself: the only certificate the workflow accepts' },
          { name: 'collectorGroup', type: 'string', value: group, description: 'The collector group, by name' },
          { name: 'startCollection', type: 'boolean', value: true, description: 'Start collection once it is created' },
        ],
        resources: [
          { name: 'credential.json', content: `${JSON.stringify({ ...credential, fields: [{ name: 'USER', value: '' }, { name: 'PASSWORD', value: '' }] }, null, 2)}\n` },
          { name: 'integration.json', content: `${JSON.stringify(integration, null, 2)}\n` },
        ],
        body: ADAPTER_BODY,
        after: String.raw`adapterInstanceId = ctx.dryRun ? "" : (adapterId || "");
summary = core.audit(ctx, { adapterInstanceId: adapterInstanceId, vcenter: settings.vcenter });
core.notify(settings.webhook, summary);`,
      });

      const apply = [
        '#!/usr/bin/env bash',
        `# Add ${vcenter} to VCF Operations: the credential first, then the adapter`,
        '# integration that uses it. The password comes from VCENTER_PASSWORD and is',
        '# only ever in memory. Without --execute this prints what it would send.',
        'set -euo pipefail',
        'cd "$(dirname "$0")"',
        ...authPreamble('vcf-operations'),
        ': "${VCENTER_PASSWORD:?set VCENTER_PASSWORD for the service account}"',
        'command -v jq >/dev/null || { echo "jq is required" >&2; exit 2; }',
        'DRY_RUN=1; [[ "${1:-}" == "--execute" ]] && DRY_RUN=0',
        'post() {',
        '  curl -sS -f -X POST "https://${VCFOPS_HOST}/suite-api/api/$1" \\',
        `    -H "${authHeader('vcf-operations')}" -H "Accept: application/json" -H "Content-Type: application/json" \\`,
        '    --data-binary @-',
        '}',
        '# post PATH reads the body from stdin, so nothing sensitive is ever an argument.',
        'if (( DRY_RUN )); then',
        `  echo "DRY RUN: would create the credential and the adapter instance for ${vcenter}. Re-run with --execute."`,
        '  exit 0',
        'fi',
        ': "${COLLECTOR_GROUP_ID:?set COLLECTOR_GROUP_ID: GET /suite-api/api/collectorgroups and take the id of the group}"',
        '# The password travels through the environment into jq and on stdin into',
        '# curl, so it is never on a command line where ps or /proc could show it.',
        'export VCENTER_PASSWORD',
        `CRED_ID=$(jq '(.fields[] | select(.name=="PASSWORD") | .value) = env.VCENTER_PASSWORD' ${base}-credential.json | post credentials | jq -r .id)`,
        '# 9.x: POST /api/integrations/vcenters. An untrusted vCenter certificate is',
        '# answered with HTTP 400 and the certificate: check its thumbprint on the',
        '# vCenter, add it under "certificates" in the JSON, and run again — or add',
        '# the account in the interface, which asks you to accept it.',
        `ADAPTER_ID=$(sed -e "s/__CREDENTIAL_ID__/$CRED_ID/" -e "s/__COLLECTOR_GROUP_ID__/$COLLECTOR_GROUP_ID/" ${base}-integration.json | post integrations/vcenters | jq -r .id)`,
        'echo "credential $CRED_ID, adapter $ADAPTER_ID"',
        'echo "Next: PUT /suite-api/api/adapters/$ADAPTER_ID/monitoringstate/start"',
        '',
      ].join('\n');

      return {
        platform: PLATFORM,
        title: `Collect from ${vcenter} as ${account}`,
        effect: 'reversible',
        trigger: { kind: 'manual', detail: 'Applied once, when a vCenter is added to monitoring.' },
        scope: {
          what: `Every object in ${vcenter} that ${account} can see.`,
          decidedBy: [`The permissions of ${account} in vCenter — collection sees exactly what the account sees.`, `The collector group "${group}", which decides which proxies do the work.`],
          ifWrong: 'An account with too little visibility produces a monitoring gap that looks like an empty cluster; one with too much is a credential worth stealing.',
        },
        guardrails: [
          { rule: 'The password is read from the environment at apply time', because: 'A credential in a payload file is a credential in every copy of the repository.' },
          { rule: 'The vCenter certificate is accepted only when its thumbprint is the one set in vcenterThumbprint', because: 'Accepting the certificate is the check that you are talking to the vCenter you think you are; accepting whatever is presented is no check at all.' },
          { rule: 'Dry run until dryRun is false; an existing adapter instance or credential is left as it is', because: 'Running it twice never adds a second adapter collecting the same vCenter.' },
          ...(actions ? [{ rule: 'Actions enabled on purpose, with an account that has exactly the action rights', because: 'Actions run as this account. Its rights are the ceiling on anything automated in this kit.' }] : []),
        ],
        dryRun: [`Run the workflow Collect from ${opsPart(base)} with dryRun = true (or scripts/apply.sh without --execute), then check the account in vCenter: Menu → Administration → Access Control → Global Permissions.`],
        undo: ['DELETE /suite-api/api/adapters/{id}. Its objects and their history are removed with it — stop it instead if you may want the history.'],
        told: ['Nobody. The self-check in this kit is what reports an adapter that stops collecting.'],
        requires: [`${account} in vCenter with read-only rights at the root${actions ? ', plus the privileges for the actions you will run' : ''}.`, `The collector group "${group}".`, OPS_PACKAGE_REQUIRES],
        files: {
          ...pkg.files,
          [`scripts/${base}-credential.json`]: `${JSON.stringify(credential, null, 2)}\n`,
          [`scripts/${base}-integration.json`]: `${JSON.stringify(integration, null, 2)}\n`,
          'scripts/apply.sh': apply,
          'IMPORT.md': importMd({
            title: 'the adapter instance',
            steps: [
              ...packageSteps(pkg, 'the workflow that adds the vCenter'),
              {
                heading: 'Or: the credential, then the integration, by the fallback script',
                files: [`scripts/${base}-credential.json`, `scripts/${base}-integration.json`, 'scripts/apply.sh'],
                how: ['VCENTER_PASSWORD=… COLLECTOR_GROUP_ID=… ./scripts/apply.sh --execute — POST /suite-api/api/credentials, then POST /suite-api/api/integrations/vcenters with the credential id. Then start collection (PUT /suite-api/api/adapters/{id}/monitoringstate/start). Or Administration → Integrations → Accounts → Add Account in the interface.'],
              },
            ],
            intro: ['Integration accounts are not imported from a file: the interface exports and imports them only inside a password-protected Content Management package, because they carry credentials. The REST API is the route — in VCF 9.x, POST /api/integrations/vcenters, which the reference names for vCenter accounts in place of POST /api/adapters.'],
          }) +
            [
              '',
              '## VERIFY on your release',
              '',
              '- the HTTP 400 answer to an untrusted certificate: the workflow finds every object with a thumbprint in it and sends the matching one back under "certificates" (the reference: "certificateDetails field must be populated"). Check that the adapter instance id the integration returns is the one PUT /api/adapters/{id}/monitoringstate/start takes, and whether a 9.x integration starts collecting on its own.',
              actions ? '- enabling actions on the integration: the 9.x integration body has no documented field for it; turn actions on in the account settings in the interface after the workflow has added it.' : '- the resource identifiers VCURL, AUTODISCOVERY and PROCESSCHANGEEVENTS, against GET /suite-api/api/adapterkinds/VMWARE/resourcekinds on your version (VM_LIMIT, which older payloads carried, is left out: the 9.x example has no such identifier).',
              '',
              '## Where these formats come from',
              '',
              `- ${API_REF} (Integrations: POST /api/integrations/vcenters; Credentials; Collector Groups; Adapters)`,
              '',
            ].join('\n'),
        },
        notes: [
          'In VCF 9.1 the management vCenter is usually added by fleet management rather than by hand. Use this for workload vCenters and anything outside the fleet.',
          'The resource identifier names (VCURL and the rest) are the VMware adapter’s. Check them against GET /suite-api/api/adapterkinds/VMWARE/resourcekinds on your version.',
          'The 9.x reference adds a vCenter through POST /api/integrations/vcenters (with vSAN and service discovery settings) rather than POST /api/adapters; both the workflow and the fallback script use it. The reference also notes that the vCenter UI/license extension registration is a separate call (PUT /api/integrations/vcenters/{id}/register), which this does not make.',
        ],
        findings,
      };
    },
  }),

  // -------------------------------------------------------------------------
  automationBlueprint({
    id: 'vcfops_outbound_plugin',
    platform: PLATFORM,
    label: 'An outbound plugin: email, webhook, syslog or SNMP',
    group: 'Setup',
    description:
      'The instance that notification rules send through. Generated with a test step, because an outbound plugin that has never sent a message is indistinguishable from one that works — until the night it matters.',
    inputs: [
      {
        id: 'kind',
        label: 'Type',
        control: 'select',
        options: [
          { value: 'StandardEmailPlugin', label: 'Email (SMTP)' },
          { value: 'WebhookPlugin', label: 'Webhook' },
          { value: 'SyslogPlugin', label: 'Syslog' },
          { value: 'SNMPTrapPlugin', label: 'SNMP trap' },
        ],
        default: 'StandardEmailPlugin',
      },
      { id: 'instance_name', label: 'Instance name', control: 'text', default: 'Platform team mail relay' },
      { id: 'host', label: 'Server or URL', control: 'text', default: 'smtp.example.com' },
      { id: 'port', label: 'Port', control: 'text', default: '587' },
      { id: 'secure', label: 'Encrypted (TLS)', control: 'toggle', default: true },
      { id: 'sender', label: 'Send as', control: 'text', default: 'vcf-operations@example.com', showWhen: { input: 'kind', equals: ['StandardEmailPlugin'] } },
    ],
    automation: (values                 , name        )             => {
      const kind = str(values, 'kind', 'StandardEmailPlugin');
      const instance = str(values, 'instance_name', 'Outbound');
      const host = str(values, 'host', '');
      const port = str(values, 'port', '');
      const secure = bool(values, 'secure', true);
      const sender = str(values, 'sender', '');
      const base = slugOf(name || instance, 'outbound');

      const findings            = [];
      if (!secure) {
        findings.push(warning('vcfops.outbound.cleartext', 'Alerts will leave VCF Operations unencrypted, and they name hosts, VMs and faults.', { source: SRC }));
      }
      if (kind === 'SNMPTrapPlugin') {
        findings.push(warning('vcfops.outbound.snmp', 'SNMP traps are fire-and-forget: nothing confirms one arrived.', { remediation: 'Use SNMPv3, and prefer a webhook where the receiver can acknowledge.', source: SRC }));
      }

      const configValues                                    =
        kind === 'StandardEmailPlugin'
          ? [
              { name: 'SMTP_HOST', value: host },
              { name: 'SMTP_PORT', value: port },
              { name: 'IS_SECURE_CONNECTION', value: String(secure) },
              { name: 'senderEmailAddress', value: sender },
              { name: 'senderName', value: 'VCF Operations' },
            ]
          : kind === 'WebhookPlugin'
            ? [{ name: 'Url', value: host }, { name: 'ConnectionCount', value: '20' }]
            : kind === 'SyslogPlugin'
              ? [{ name: 'host', value: host }, { name: 'port', value: port }, { name: 'protocol', value: secure ? 'TCP' : 'UDP' }]
              : [{ name: 'destination_host', value: host }, { name: 'port', value: port }, { name: 'version', value: 'v3' }];

      const payload = { pluginTypeId: kind, name: instance, configValues };
      const pkg = opsPackage({
        parts: ['outbound', base],
        folder: `outbound-${base}`,
        description: `Creates the ${kind} outbound instance "${instance}" once, tests it and enables it.`,
        workflowName: `Create outbound ${opsPart(base)}`,
        workflowDescription: `Creates the outbound instance "${instance}" (${kind}) unless one of that name exists, then tests it (POST alertplugins/{id}/test) and enables it only when the test passed.`,
        changes: true,
        cap: 3,
        outputs: [{ name: 'pluginId', type: 'string', description: 'The outbound instance id, empty in a dry run' }],
        account: 'An account that may manage outbound settings',
        settings: [{ name: 'testAndEnable', type: 'boolean', value: true, description: 'Test a newly created instance, and enable it when the test passes' }],
        resources: [{ name: 'plugin.json', content: `${JSON.stringify(payload, null, 2)}\n` }],
        body: OUTBOUND_BODY,
        after: String.raw`pluginId = ctx.dryRun ? "" : (pluginRef || "");
summary = core.audit(ctx, { pluginId: pluginId, next: "Check the test message actually arrived before a notification rule depends on it." });
core.notify(settings.webhook, summary);`,
      });

      return {
        platform: PLATFORM,
        title: `${instance} — ${kind.replace('Plugin', '').replace('Standard', '')} outbound to ${host}`,
        effect: 'reversible',
        trigger: { kind: 'manual', detail: 'Applied once. It sends only when a notification rule uses it.' },
        scope: {
          what: `Every notification rule that names "${instance}".`,
          decidedBy: ['The notification rules attached to it — the plugin itself decides nothing about what is sent.'],
          ifWrong: 'Notifications go nowhere, silently. The rules look configured and the alerts look raised.',
        },
        guardrails: [
          { rule: 'Tested before any rule depends on it: the workflow enables a new instance only after its test call succeeded', because: 'The test is the only moment anyone sees it fail.' },
          { rule: 'Dry run until dryRun is false; an instance of the same name is left as it is', because: 'Re-running it never adds a second instance for the rules to be split across.' },
          ...(secure ? [{ rule: 'Encrypted in transit', because: 'Alert text names systems and faults; it is reconnaissance for anyone on the path.' }] : []),
        ],
        dryRun: [`Run the workflow Create outbound ${opsPart(base)} with dryRun = true (or scripts/apply.sh without --execute). After it has run for real, check the test message actually arrived.`],
        undo: ['DELETE /suite-api/api/alertplugins/{id}. Rules that use it stop sending; they do not fail loudly.'],
        told: ['Whoever the rules send to, through this instance.'],
        requires: [kind === 'StandardEmailPlugin' ? `Your mail relay to accept ${sender} from the VCF Operations nodes.` : `A route from the VCF Operations nodes to ${host}:${port}.`, 'Any credential for the target entered in the interface, not in this file.', OPS_PACKAGE_REQUIRES],
        files: {
          ...pkg.files,
          [`scripts/${base}.json`]: `${JSON.stringify(payload, null, 2)}\n`,
          'scripts/apply.sh': inScripts(applyScript('vcf-operations', [{ method: 'POST', path: '/suite-api/api/alertplugins', payload: `${base}.json` }], 'DELETE /suite-api/api/alertplugins/{id}.')),
          'IMPORT.md': importMd({
            title: 'the outbound instance',
            intro: ['Outbound settings are exported and imported by the interface only with a password (they can hold credentials), in a form that is not documented; what is here is the REST body, and the workflow that sends it.'],
            steps: [
              ...packageSteps(pkg, 'the workflow that creates, tests and enables the outbound instance'),
              {
                heading: 'Or: the outbound instance by the fallback script',
                files: [`scripts/${base}.json`, 'scripts/apply.sh'],
                how: ['./scripts/apply.sh --execute — POST /suite-api/api/alertplugins, then test it (POST /suite-api/api/alertplugins/{id}/test) and enable it (PUT /suite-api/api/alertplugins/{id}/enable/true). Or Configure → Alerts → Outbound Settings → Add in the interface, with the values from the file.'],
                verify: [`the configValues names (${configValues.map((v) => v.name).join(', ')}) against GET /suite-api/api/alertplugins/types/${kind} on your release: they differ between plugin types and releases, and a name the release does not know is dropped without an error.`, 'POST /api/alertplugins/{id}/test takes no body in the 9.x reference as read here; if your release wants one, test in the interface and enable by hand (testAndEnable false).'],
              },
            ],
            sources: [`${API_REF} (Alert Plugins)`],
          }),
        },
        notes: ['Config value names differ between plugin types and releases. GET /suite-api/api/alertplugins/types lists the fields your version expects; match them before applying.', 'Created disabled until enabled: PUT /suite-api/api/alertplugins/{id}/enable/true once the test has passed.'],
        findings,
      };
    },
  }),

  // -------------------------------------------------------------------------
  automationBlueprint({
    id: 'vcfops_access',
    platform: PLATFORM,
    label: 'Give a team a role on part of the estate',
    group: 'Setup',
    description:
      'A directory group imported with a role and a scope, so an application team sees its own VMs and the platform team sees everything. Written against groups rather than people, and against a scope rather than the whole estate, because both are the shortcuts that get taken.',
    inputs: [
      { id: 'group', label: 'Directory group', control: 'text', default: 'APP-Payments-Ops' },
      { id: 'source', label: 'Authentication source', control: 'text', default: 'Corporate AD' },
      {
        id: 'role',
        label: 'Role',
        control: 'select',
        options: [
          { value: 'ReadOnly', label: 'Read only' },
          { value: 'ContentAdmin', label: 'Content administrator' },
          { value: 'PowerUser', label: 'Power user' },
          { value: 'Administrator', label: 'Administrator — see the finding' },
        ],
        default: 'ReadOnly',
      },
      { id: 'scope_objects', label: 'On these objects', control: 'text', default: 'Payments VMs', hint: 'Custom groups or containers. Empty means everything' },
    ],
    automation: (values                 , name        )             => {
      const group = str(values, 'group', '');
      const source = str(values, 'source', '');
      const role = str(values, 'role', 'ReadOnly');
      const scope = listOf(str(values, 'scope_objects', ''));
      const base = slugOf(name || `${group}-${role}`, 'access');

      const findings            = [];
      if (role === 'Administrator') {
        findings.push(warning('vcfops.access.admin', 'Administrator includes managing adapters, credentials and every other user.', { remediation: 'Keep it to the platform team. Content administrator covers dashboards, alerts and policies.', source: SRC }));
      }
      if (scope.length === 0 && role !== 'ReadOnly') {
        findings.push(warning('vcfops.access.unscoped', `${role} on every object in the estate.`, { remediation: 'Scope it to the custom groups the team owns.', source: SRC }));
      }
      if (/@/.test(group)) {
        findings.push(warning('vcfops.access.person', `${group} looks like a person rather than a group.`, { remediation: 'Grant to groups. People move teams, and a grant to a person moves with them.', source: SRC }));
      }

      // Field names are hyphenated in this API. Scope is a traversal spec plus
      // the ids of the objects within it — not the object's name.
      const payload = {
        authSourceId: `<REQUIRED — GET /suite-api/api/auth/sources and take the id of ${source}>`,
        name: group,
        'role-permissions': [
          {
            roleName: role,
            allowAllObjects: scope.length === 0,
            'traversal-spec-instances': scope.length === 0 ? [] : [
              {
                adapterKind: 'Container',
                resourceKind: 'Environment',
                name: '<REQUIRED — GET /suite-api/api/auth/traversalspecs and take the name of the Custom Groups spec>',
                resourceSelection: [
                  {
                    type: 'PROPAGATE',
                    resourceId: scope.map((object) => `<REQUIRED — the id of the custom group "${object}">`),
                  },
                ],
              },
            ],
          },
        ],
      };

      const pkg = opsPackage({
        parts: ['access', base],
        folder: `access-${base}`,
        description: `Imports the directory group ${group} from "${source}" with the role ${role}${scope.length > 0 ? ` on ${scope.join(', ')}` : ''}, once.`,
        workflowName: `Grant ${opsPart(base)}`,
        workflowDescription: `Finds the authentication source "${source}", the custom-group traversal spec and the custom groups ${scope.join(', ') || '(none: every object)'} by name, and imports ${group} with the role ${role} on them — unless a user group of that name exists, which is left as it is.`,
        changes: true,
        cap: 1,
        outputs: [{ name: 'userGroupId', type: 'string', description: 'The user group id, empty in a dry run' }],
        account: 'An account that may manage access control',
        settings: [
          { name: 'authSource', type: 'string', value: source, description: 'The authentication source, by name (GET auth/sources)' },
          { name: 'scopeGroups', type: 'Array/string', value: scope, description: 'The custom groups the role applies to; empty means every object' },
          { name: 'traversalSpecName', type: 'string', value: '', description: 'The traversal spec for custom groups; empty when there is exactly one' },
        ],
        resources: [{ name: 'usergroup.json', content: `${JSON.stringify(payload, null, 2)}\n` }],
        body: ACCESS_BODY,
        after: String.raw`userGroupId = ctx.dryRun ? "" : (groupRef || "");
summary = core.audit(ctx, { userGroupId: userGroupId });
core.notify(settings.webhook, summary);`,
      });

      return {
        platform: PLATFORM,
        title: `${group} — ${role} on ${scope.join(', ') || 'the whole estate'}`,
        effect: 'reversible',
        trigger: { kind: 'manual', detail: 'Applied once, as an access change.' },
        scope: {
          what: `Members of ${group}, on ${scope.join(', ') || 'every object'}.`,
          decidedBy: [`Membership of ${group} in ${source} — which is managed outside VCF Operations.`, `The role ${role}.`, scope.length > 0 ? `The objects ${scope.join(', ')} and everything under them.` : 'No scope: every object.'],
          ifWrong: 'People see or change what they should not, and because membership is in the directory, the change that caused it is not in VCF Operations at all.',
        },
        guardrails: [
          { rule: 'Granted to a directory group', because: 'Leavers are removed from the directory once; nobody remembers every tool they had access to.' },
          ...(scope.length > 0 ? [{ rule: `Scoped to ${scope.join(', ')}`, because: 'A team that sees only its own VMs gets dashboards that make sense to it.' }] : []),
          { rule: 'The workflow resolves every name to an id before it grants anything, and leaves an existing user group alone', because: 'A scope with a missing group in it would grant less than asked; a second import would be a second grant to reconcile.' },
        ],
        dryRun: [`Run the workflow Grant ${opsPart(base)} with dryRun = true: it resolves the source, the spec and the groups and logs the grant it would make.`, 'After applying, sign in as a member (or use Access Control → the group → Objects) and check what is visible.'],
        undo: ['DELETE /suite-api/api/auth/usergroups/{id}. Members lose access at their next sign-in.'],
        told: ['Nobody automatically. Record the grant with the access request that asked for it.'],
        requires: [`The authentication source "${source}" configured, and ${group} present in it.`, scope.length > 0 ? 'The custom groups named in the scope.' : 'Nothing else.', OPS_PACKAGE_REQUIRES],
        files: {
          ...pkg.files,
          [`scripts/${base}.json`]: `${JSON.stringify(payload, null, 2)}\n`,
          'scripts/apply.sh': inScripts(applyScript('vcf-operations', [{ method: 'POST', path: '/suite-api/api/auth/usergroups', payload: `${base}.json` }], 'DELETE /suite-api/api/auth/usergroups/{id}.')),
          'IMPORT.md': importMd({
            title: 'the user group and its access',
            steps: [
              ...packageSteps(pkg, 'the workflow that imports the group with its role'),
              {
                heading: 'Or: the group by the fallback script',
                files: [`scripts/${base}.json`, 'scripts/apply.sh'],
                how: ['Fill in the <REQUIRED> ids, then ./scripts/apply.sh --execute — POST /suite-api/api/auth/usergroups. Or Administration → Control Panel → Access Control → User Groups → Import from the identity source, then assign the role and scope shown in the file.'],
                verify: [
                  'Access Control has an export/import of user groups, in its own file shape; it is not generated here — the REST body is.',
                  'for a directory (LDAP/AD) source, the 9.x reference asks for the distinguishedName in name, and says to check the group exists first with POST /suite-api/api/auth/sources/{id}/usergroups/search; for the VCF Identity Broker (VIDB) source, the group may also need externalId. The workflow sends the name as given.',
                  'the traversal spec and resource selection for custom groups: GET /suite-api/api/auth/traversalspecs lists "specs", but the reference gives no example of their names; compare with GET /suite-api/api/auth/usergroups/{id}/permissions of a group scoped the same way in the interface.',
                ],
              },
            ],
            sources: [`${API_REF} (Auth: user groups, sources, traversal specs)`],
          }),
        },
        notes: ['Compare the payload with GET /suite-api/api/auth/usergroups for a group already scoped the same way in the interface — the traversal spec name and selection type are the parts that differ between releases.', 'Role names are the internal ones. GET /suite-api/api/auth/roles lists what your instance calls them, including any custom roles.', 'In VCF 9.1 identity is shared across the fleet; if the group already has access through VCF SSO, check that before adding a second grant here.'],
        findings,
      };
    },
  }),
];
