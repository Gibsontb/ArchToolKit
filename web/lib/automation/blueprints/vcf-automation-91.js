/**
 * VCF Automation 9.1 and 9.1.1: what the 8.x-shaped blueprints do not cover.
 *
 * The other VCF Automation files in this kit are written against the APIs that
 * carried over from 8.x — /iaas/api, /blueprint/api, /policy/api —
 * which is what a VM Apps organisation still speaks. VCF Automation 9 added a
 * second half that came from Cloud Director and the Supervisor: a provider
 * portal with organisations, regions and quotas (/cloudapi), OAuth API tokens
 * per organisation (/oauth/provider/token, /oauth/tenant/{org}/token), and an
 * All Apps organisation consumed as Kubernetes objects — VMs through VM
 * Service, subnets through the NSX VPC operator, databases through Data
 * Services Manager.
 *
 * Sources: Broadcom TechDocs for 9.1 (generating provider management API
 * tokens; VCF Automation 9.1 what's new; VCF Automation 9.1.1 and 9.1.0.0200
 * release notes), the vmware/vcfa Terraform provider documentation (v1.2.x,
 * which states support for VCF Automation 9.1), vrealize.it on API access and
 * programmatic tokens, Tom Fojta and Cormac Hogan on All Apps networking and
 * Data Services, and the VM Service and Argo CD examples published for 9.x.
 *
 * Where a path, apiVersion or field name could not be confirmed against a 9.1
 * system the file says VERIFY and says how to check, rather than guessing
 * quietly. Terraform is used for provider-side objects because the vmware/vcfa
 * provider is the one documented, supported client for them.
 */

import { bool, num, str,                      } from '../../kit/blueprint.js';
import { error, info, warning,              } from '../../core/findings.js';
import { automationBlueprint,                          } from '../from-automation.js';
import { listOf, slugOf,                 } from '../automation.js';
import { blueprintYaml, importBundle, importMd, kubeStep, manualStep, verifyFor,                 } from '../vcfa-import.js';
import { packageNameOf, toPackage } from '../vro/to-package.js';
import { familyOf, isAnyNetwork, parseCidrAny } from '../../core/ip.js';
import { nsxEnsureLines, nsxScript, portOf, rowsOf,                                } from './vcf-automation-91-kit.js';
import { vcfa91Govern } from './vcf-automation-91-govern.js';
import { vcfa91Network } from './vcf-automation-91-network.js';

const ALL_APPS = 'VCF Automation 9.1 / 9.1.1 All Apps organizations';
const PROVIDER = 'VCF Automation 9.1 / 9.1.1, provider (System) side';

/** The Terraform route: plan, read, apply exactly the plan. */
function tfStep(heading        , what        )             {
  return manualStep(heading, [
    `\`VCFA_URL=https://<vcfa> VCFA_ORG=<org> VCFA_API_TOKEN_FILE=<file> ./scripts/plan.sh\` runs terraform init and plan on the .tf files beside scripts/, saves the plan and applies exactly that saved plan. \`./scripts/plan.sh --dry-run\` stops after the plan, so you can read it first. ${what}`,
  ]);
}

/** A read-only check to run after the import. */
function checkStep(script        , what        )             {
  return manualStep(`Or check it from a Linux host — scripts/${script}`, [`\`./scripts/${script}\` reads only and exits 1 when something needs attention: ${what}`]);
}

const PLATFORM = 'vcf-automation'         ;
const SRC = 'ArchToolKit';

const json = (value         )         => `${JSON.stringify(value, null, 2)}\n`;

/** A Kubernetes / RFC 1123 label: lower case, digits and hyphens, at most 63. */
const LABEL = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;

function label(text        , fallback        )         {
  return slugOf(text, fallback).slice(0, 63).replace(/-+$/, '') || fallback;
}

/** A value for HCL or YAML inside double quotes. */
function q(text        )         {
  return JSON.stringify(text);
}

                                   

// --- shell building blocks ---------------------------------------------------

/**
 * Get a VCF Automation 9 access token, unless one is already in VCFA_TOKEN.
 *
 * The API token (an OAuth refresh token) is read from a file that must be mode
 * 600 or 400 and sent on stdin, so it is never an argument to anything. When
 * the organisation has token rotation on, the exchange answers with a new API
 * token and the old one stops working; the new one is written back before
 * anything else happens, because losing it means generating a new token in the
 * interface.
 */
function authLines(scope       )           {
  return [
    ': "${VCFA_HOST:?set VCFA_HOST, e.g. vcfa.example.com}"',
    'API_VERSION="${VCFA_API_VERSION:-9.1.0}"',
    ...(scope === 'tenant'
      ? [': "${VCFA_ORG:?set VCFA_ORG to the organization name, as it appears in its login URL}"', 'OAUTH_PATH="/oauth/tenant/${VCFA_ORG}/token"']
      : ['OAUTH_PATH="/oauth/provider/token"']),
    'command -v jq >/dev/null || { echo "jq is required" >&2; exit 2; }',
    'if [[ -z "${VCFA_TOKEN:-}" ]]; then',
    '  : "${VCFA_API_TOKEN_FILE:?set VCFA_TOKEN, or VCFA_API_TOKEN_FILE to a mode-600 file holding a VCF Automation API token}"',
    '  PERM=$(stat -c %a "$VCFA_API_TOKEN_FILE" 2>/dev/null || stat -f %Lp "$VCFA_API_TOKEN_FILE")',
    '  [[ "$PERM" == 600 || "$PERM" == 400 ]] || { echo "$VCFA_API_TOKEN_FILE is mode $PERM; make it 600 so only its owner can read it" >&2; exit 2; }',
    "  RESP=$( { printf 'grant_type=refresh_token&refresh_token='; jq -jn --rawfile p \"$VCFA_API_TOKEN_FILE\" '$p | rtrimstr(\"\\n\") | @uri'; } |",
    '    curl -sS -f -X POST "https://${VCFA_HOST}${OAUTH_PATH}" -H "Accept: application/*" -H "Content-Type: application/x-www-form-urlencoded" --data-binary @-)',
    "  VCFA_TOKEN=$(jq -r '.access_token // empty' <<<\"$RESP\")",
    '  [[ -n "$VCFA_TOKEN" ]] || { echo "The token exchange at ${OAUTH_PATH} returned no access_token" >&2; exit 2; }',
    "  NEW_REFRESH=$(jq -r '.refresh_token // empty' <<<\"$RESP\")",
    "  if [[ -n \"$NEW_REFRESH\" && \"$NEW_REFRESH\" != \"$(tr -d '\\n' < \"$VCFA_API_TOKEN_FILE\")\" ]]; then",
    "    ( umask 077; printf '%s\\n' \"$NEW_REFRESH\" > \"${VCFA_API_TOKEN_FILE}.new\" ) && mv \"${VCFA_API_TOKEN_FILE}.new\" \"$VCFA_API_TOKEN_FILE\"",
    '    echo "Token rotation is on: ${VCFA_API_TOKEN_FILE} now holds the new API token; the old one no longer works." >&2',
    '  fi',
    '  unset RESP NEW_REFRESH',
    'fi',
  ];
}

/** GET with the bearer token passed to curl on a file descriptor, never in argv. */
function httpLines()           {
  return [
    '# The bearer token reaches curl as a config on a file descriptor, not as an argument.',
    "auth_cfg() { printf 'header = \"Authorization: Bearer %s\"\\n' \"$VCFA_TOKEN\"; }",
    "cloudapi_type() { printf 'application/json;version=%s' \"$API_VERSION\"; }",
    'get() {  # get PATH [ACCEPT] — /cloudapi wants the versioned type, /iaas and /blueprint plain JSON',
    '  curl -sS -f -K <(auth_cfg) "https://${VCFA_HOST}$1" -H "Accept: ${2:-$(cloudapi_type)}"',
    '}',
    '# probe PATH: like get, but a 404 says the path is not on this release instead of failing silently.',
    'probe() {',
    '  local code',
    '  code=$(curl -sS -o /tmp/vcfa-probe.$$ -w "%{http_code}" -K <(auth_cfg) "https://${VCFA_HOST}$1" -H "Accept: ${2:-$(cloudapi_type)}") || true',
    '  if [[ "$code" == 200 ]]; then cat /tmp/vcfa-probe.$$; rm -f /tmp/vcfa-probe.$$; return 0; fi',
    '  rm -f /tmp/vcfa-probe.$$',
    '  echo "VERIFY: $1 answered HTTP $code on this release — check the path in the API explorer" >&2',
    '  return 1',
    '}',
  ];
}

/** Stop before sending anything if the server does not offer the API version the payloads are written for. */
function versionCheckLines()           {
  return [
    'if VERS=$(curl -sS -f "https://${VCFA_HOST}/api/versions" -H "Accept: application/json" 2>/dev/null); then',
    '  grep -q "${API_VERSION}" <<<"$VERS" || { echo "API version ${API_VERSION} is not offered by ${VCFA_HOST}; set VCFA_API_VERSION to one GET /api/versions lists" >&2; exit 2; }',
    'else',
    '  echo "warning: /api/versions did not answer; carrying on with version ${API_VERSION} unchecked" >&2',
    'fi',
  ];
}

function sendLines()           {
  return [
    'DRY_RUN=0',
    '[[ " $* " == *" --dry-run "* ]] && DRY_RUN=1',
    'send() {  # send METHOD PATH FILE [TYPE]',
    '  local method="$1" path="$2" file="$3" type="${4:-$(cloudapi_type)}"',
    '  if (( DRY_RUN )); then echo "DRY RUN: would ${method} ${file} to https://${VCFA_HOST}${path}"; return 0; fi',
    '  echo "${method} ${path}" >&2',
    '  curl -sS -f -K <(auth_cfg) -X "$method" "https://${VCFA_HOST}${path}" -H "Accept: ${type}" -H "Content-Type: ${type}" --data-binary @"$file"',
    '  echo',
    '}',
  ];
}

function restScript(opts                                                                                                                 )         {
  return [
    '#!/usr/bin/env bash',
    `# ${opts.purpose}`,
    '#',
    opts.act
      ? '# Applies when run. With --dry-run this only reads and prints what it would send.'
      : '# Reads only. Exits 1 when something needs attention, so a scheduler can alert on the exit code.',
    `# Authenticates as ${opts.scope === 'provider' ? 'the provider (System), at /oauth/provider/token' : 'an organization, at /oauth/tenant/$VCFA_ORG/token'}.`,
    'set -euo pipefail',
    '',
    ...authLines(opts.scope),
    '',
    ...httpLines(),
    '',
    ...(opts.checkVersion ? [...versionCheckLines(), ''] : []),
    ...(opts.act ? [...sendLines(), ''] : []),
    ...opts.body,
    '',
    ...(opts.act ? ['if (( DRY_RUN )); then echo "Dry run: nothing was changed. Run it without --dry-run to apply."; fi', ''] : []),
    ...(opts.undo ? [`# Undo: ${opts.undo}`, ''] : []),
  ].join('\n');
}

/**
 * kubectl against a VCF Automation (CCI) or Supervisor context. Creates when
 * run; --dry-run makes it a server-side dry run. Create rather than apply, because the VCF Automation
 * endpoint rejects the last-applied annotation apply depends on, and because
 * create refuses to overwrite an object that already exists.
 */
function kubeScript(purpose        , pre                   , files                   , undo        , verb                     = 'create')         {
  return [
    '#!/usr/bin/env bash',
    `# ${purpose}`,
    '#',
    '# Log in first with the VCF CLI, e.g.',
    '#   vcf context create <name> --type cci --endpoint https://$VCFA_HOST --tenant-name <org>',
    '#   vcf context use <name>:<namespace>:<project>',
    '# Leave --api-token off so the CLI asks for it, rather than putting the token in',
    '# your shell history and the process list (VERIFY the prompt on your CLI version).',
    '#',
    '# Applies when run. With --dry-run this is a server-side dry run: the server validates, nothing is created.',
    '# It reads the manifests beside the scripts/ folder it is in.',
    'set -euo pipefail',
    'cd "$(dirname "$0")/.."',
    '',
    'command -v kubectl >/dev/null || { echo "kubectl is required" >&2; exit 2; }',
    ': "${EXPECT_CONTEXT:?set EXPECT_CONTEXT to the kubectl context this is meant for — the context is the scope}"',
    'CTX=$(kubectl config current-context)',
    '[[ "$CTX" == "$EXPECT_CONTEXT" ]] || { echo "Current context is $CTX, not $EXPECT_CONTEXT. Switch with vcf context use." >&2; exit 2; }',
    'echo "Context: $CTX"',
    '',
    'MODE=()',
    '[[ " $* " == *" --dry-run "* ]] && MODE=(--dry-run=server)',
    '',
    ...pre,
    ...files.map((file) => `kubectl ${verb} "\${MODE[@]}" -f '${file}'`),
    '',
    'if [[ ${#MODE[@]} -gt 0 ]]; then echo "Server-side dry run only. Nothing was created. Run it without --dry-run to apply."; fi',
    '',
    `# Undo: ${undo}`,
    '',
  ].join('\n');
}

/** Read-only kubectl script. */
function kubeReadScript(purpose        , body                   )         {
  return [
    '#!/usr/bin/env bash',
    `# ${purpose}`,
    '#',
    '# Reads only, from the current kubectl context. Exits 1 when something needs attention.',
    'set -euo pipefail',
    'command -v kubectl >/dev/null || { echo "kubectl is required" >&2; exit 2; }',
    'echo "Context: $(kubectl config current-context)"',
    'PROBLEMS=0',
    '',
    ...body,
    '',
    'exit $(( PROBLEMS > 0 ? 1 : 0 ))',
    '',
  ].join('\n');
}

/** terraform init, plan and apply of that plan; --dry-run stops after the plan. */
function tfScript(purpose        , undo        )         {
  return [
    '#!/usr/bin/env bash',
    `# ${purpose}`,
    '#',
    '# init, plan (saved to tfplan), then apply exactly that plan. With --dry-run: stop',
    '# after the plan so it can be read.',
    '# Terraform runs in the folder above scripts/, where the .tf files are.',
    'set -euo pipefail',
    'cd "$(dirname "$0")/.."',
    'command -v terraform >/dev/null || { echo "terraform is required" >&2; exit 2; }',
    ': "${VCFA_URL:?set VCFA_URL, e.g. https://vcfa.example.com}"',
    ': "${VCFA_ORG:?set VCFA_ORG — System for provider work, the organization name for tenant work}"',
    'if [[ -z "${VCFA_API_TOKEN:-}" ]]; then',
    '  : "${VCFA_API_TOKEN_FILE:?set VCFA_API_TOKEN_FILE to a mode-600 file holding the API token}"',
    "  VCFA_API_TOKEN=\"$(tr -d '\\n' < \"$VCFA_API_TOKEN_FILE\")\"",
    'fi',
    'export VCFA_URL VCFA_ORG VCFA_API_TOKEN',
    '',
    'terraform init -input=false',
    'terraform plan -input=false -out=tfplan',
    'if [[ " $* " == *" --dry-run "* ]]; then',
    '  echo "Dry run: plan saved to tfplan, nothing applied. Run it without --dry-run to apply."',
    '  exit 0',
    'fi',
    'terraform apply -input=false tfplan',
    'rm -f tfplan',
    '',
    `# Undo: ${undo}`,
    '',
  ].join('\n');
}

const VERSIONS_TF = [
  '# The vmware/vcfa provider. 1.2.x documents support for VCF Automation 9.1.',
  'terraform {',
  '  required_version = ">= 1.5.0"',
  '  required_providers {',
  '    vcfa = {',
  '      source  = "vmware/vcfa"',
  '      version = "~> 1.2.2"',
  '    }',
  '  }',
  '}',
  '',
  '# URL, org and the API token come from VCFA_URL, VCFA_ORG and VCFA_API_TOKEN,',
  '# which plan.sh sets from a mode-600 file. Nothing secret is written here.',
  'provider "vcfa" {',
  '  auth_type            = "api_token"',
  '  allow_unverified_ssl = false',
  '}',
  '',
].join('\n');

function cronLine(schedule        , env        , script        , log        )         {
  return [
    '# Crontab entry. No secret in it: the script reads the API token from the file named.',
    `${schedule} ${env} /opt/vcf-automation/scripts/${script} >>/var/log/vcf-automation/${log} 2>&1`,
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// The Orchestrator packages.
//
// Every automation here is also one Orchestrator package (to-package.ts): a
// workflow on the shared core library, with its settings and its payloads.
// The bash, kubectl and Terraform files stay beside it — the scripts under
// scripts/, the native files (Kubernetes YAML, .tf, JSON payloads, the
// blueprint.yaml) where they were — for whoever imports by hand.
//
// Three APIs are reached from the workflows, each with the organization (or
// provider) bearer token core.loginVcfAutomation gets from the API token:
//
//   /cloudapi           provider objects: organizations, regions, quotas,
//                       content libraries, API tokens. Paths follow the
//                       go-vcloud-director v3 SDK the vmware/vcfa Terraform
//                       provider is built on (types/v56 constants; govcd/tm_*.go):
//                       orgs and tokens under /cloudapi/1.0.0/, the region family,
//                       region quotas (virtualDatacenters), VM classes
//                       (virtualMachineClasses) and content libraries under
//                       /cloudapi/vcf/. The Accept header carries the API version:
//                       the configured one, checked against GET /api/versions, or
//                       the newest it lists (Broadcom KB 419781 uses 40.0 on 9.0).
//   /cci/kubernetes     organization-level Kubernetes objects of an All Apps
//                       organization — SupervisorNamespace, Project — at
//                       https://<vcfa>/cci/kubernetes (ccitypes.KubernetesSubpath,
//                       SupervisorNamespacesURL: /apis/infrastructure.cci.vmware.com/
//                       v1alpha3/namespaces/<project>/supervisornamespaces).
//   kubeServer          namespace-level objects (VMs, subnets, databases, policies,
//                       Argo CD): the Kubernetes API server of the namespace
//                       context, as `vcf context create --type cci` writes it into
//                       the kubeconfig. The path behind it is not documented, so it
//                       is a setting copied from the kubeconfig, not a guess.
//   /iaas/api, /blueprint/api   VM Apps organizations, as in 8.x.

/** A value for YAML: plain when that is unambiguous, otherwise a JSON (double-quoted) string. */
function yamlScalar(value         )         {
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value === null || value === undefined) return 'null';
  const s = String(value);
  const plain = /^[A-Za-z0-9_./][A-Za-z0-9_ ./@+=-]*$/.test(s) && !/\s$/.test(s) && !/^(true|false|null|yes|no|on|off|y|n)$/i.test(s) && !/^[-+]?[0-9][0-9._]*$/.test(s);
  return plain ? s : JSON.stringify(s);
}

/** A plain object as block YAML; a string with line breaks as a literal block. */
function yamlLines(value         , indent        )           {
  const pad = ' '.repeat(indent);
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      if (item !== null && typeof item === 'object' && !Array.isArray(item) && Object.keys(item).length > 0) {
        const inner = yamlLines(item, indent + 2);
        return [`${pad}- ${inner[0] .trimStart()}`, ...inner.slice(1)];
      }
      if (item !== null && typeof item === 'object') return [`${pad}- ${Array.isArray(item) ? '[]' : '{}'}`];
      return [`${pad}- ${yamlScalar(item)}`];
    });
  }
  if (value !== null && typeof value === 'object') {
    return Object.entries(value                           ).flatMap(([key, v]) => {
      const k = yamlScalar(key);
      if (typeof v === 'string' && v.includes('\n')) return [`${pad}${k}: |`, ...v.replace(/\n$/, '').split('\n').map((line) => `${pad}  ${line}`)];
      if (Array.isArray(v)) return v.length === 0 ? [`${pad}${k}: []`] : [`${pad}${k}:`, ...yamlLines(v, indent + 2)];
      if (v !== null && typeof v === 'object') return Object.keys(v).length === 0 ? [`${pad}${k}: {}`] : [`${pad}${k}:`, ...yamlLines(v, indent + 2)];
      return [`${pad}${k}: ${yamlScalar(v)}`];
    });
  }
  return [`${pad}${yamlScalar(value)}`];
}

/** Kubernetes documents as a multi-document YAML file, each with its comment lines. */
function k8sYaml(docs                                                                              )         {
  return `${docs.map((d) => ['---', ...(d.comment ?? []).map((c) => `# ${c}`), ...yamlLines(d.object, 0)].join('\n')).join('\n')}\n`;
}

/** A Kubernetes object the workflow creates: the object and its resource (plural) name. */
                      
                          
                                                                                                                                                                                                                                   
 

const VCFA_HOST_ATTR = { name: 'vcfaHost', type: 'string', value: '', description: 'VCF Automation host (FQDN)' }         ;
const TOKEN_ATTR = (whose        ) => ({ name: 'vcfaApiToken', type: 'SecureString', description: `An API token of ${whose} (My Account → API Tokens). Stored encrypted, never logged.` })         ;
const ORG_ATTR = (org        ) => ({ name: 'vcfaOrg', type: 'string', value: org, description: 'The organization name as in its login URL; "provider" for the provider (System) portal' })         ;
const API_VERSION_ATTR = { name: 'apiVersion', type: 'string', value: '', description: 'The /cloudapi version for the Accept header; empty: the newest GET /api/versions lists' }         ;
const KUBE_ATTR = { name: 'kubeServer', type: 'string', value: '', description: 'The Kubernetes API server of the namespace context: kubectl config view --minify -o jsonpath=\'{.clusters[0].cluster.server}\' after vcf context use' }         ;
const GUARD_ATTRS = (cap        ) =>
  [
    { name: 'dryRun', type: 'boolean', value: false, description: 'Set to true to preview: nothing is changed while it is true' },
    { name: 'cap', type: 'number', value: cap, description: 'The most changes one run may make' },
  ]         ;
const WEBHOOK_ATTR = { name: 'webhook', type: 'SecureString', description: 'Optional: where the audit record is posted' }         ;

/** What the workflows share: the settings check and the login. */
const LOGIN_JS = (org               ) => String.raw`var SAFE = { redact: settings._secrets };
if (!settings.vcfaHost || !settings.vcfaApiToken) throw new Error("Set vcfaHost and vcfaApiToken in the configuration element " + SETTINGS_NAME + ".");
var ORG = ${org === null ? 'settings.vcfaOrg ? String(settings.vcfaOrg) : ""' : JSON.stringify(org)};
if (!ORG) throw new Error("Set vcfaOrg in the configuration element " + SETTINGS_NAME + ": the organization name, or provider.");
`;

/** /cloudapi: the API version, list, probe and send. CLOUD is set once logged in. */
const CLOUDAPI_JS = String.raw`// The versions GET /api/versions lists (it needs no login), JSON or XML.
function versionsOffered(host) {
  var r = core.http("GET", "https://" + host + "/api/versions", null, null, { accept: "application/json", allow: [400, 401, 403, 404, 406] });
  var found = [];
  var re = /"version"\s*:\s*"([0-9]+(?:\.[0-9]+)*)"|<Version>([0-9]+(?:\.[0-9]+)*)<\/Version>/g;
  var m;
  while ((m = re.exec(String(r.text))) !== null) found.push(m[1] || m[2]);
  return found;
}
function newerVersion(a, b) {
  var x = String(a).split(".");
  var y = String(b).split(".");
  for (var i = 0; i < Math.max(x.length, y.length); i++) {
    var p = Number(x[i] || 0);
    var q = Number(y[i] || 0);
    if (p !== q) return p > q;
  }
  return false;
}
// The configured version, refused if the server does not offer it; else the newest offered.
function pickVersion(host, wanted) {
  var offered = versionsOffered(host);
  if (wanted) {
    if (offered.length > 0 && offered.indexOf(String(wanted)) < 0) throw new Error("API version " + wanted + " is not offered by " + host + " (GET /api/versions lists " + offered.join(", ") + "). Set apiVersion to one of them, or leave it empty.");
    if (offered.length === 0) System.warn("GET /api/versions listed nothing; using API version " + wanted + " unchecked.");
    return String(wanted);
  }
  if (offered.length === 0) throw new Error("GET /api/versions on " + host + " listed no version; set apiVersion in the configuration element " + SETTINGS_NAME + ".");
  var best = offered[0];
  for (var i = 1; i < offered.length; i++) if (newerVersion(offered[i], best)) best = offered[i];
  System.log("Using API version " + best + ", the newest " + host + " offers.");
  return best;
}
var CLOUD = null;
function cloudUrl(path) { return "https://" + CLOUD.host + "/cloudapi/" + path; }
function cloudGet(path) {
  return core.http("GET", cloudUrl(path), CLOUD.auth, null, { accept: CLOUD.type, redact: SAFE.redact }).body || {};
}
// A path that answers 404 is reported as VERIFY — the path moved on this release — not ignored.
function cloudProbe(path) {
  var r = core.http("GET", cloudUrl(path), CLOUD.auth, null, { accept: CLOUD.type, allow: [404], redact: SAFE.redact });
  if (r.statusCode === 404) {
    System.warn("VERIFY: /cloudapi/" + String(path).split("?")[0] + " answered HTTP 404 on this release; check the path in the API explorer.");
    return null;
  }
  return r.body || {};
}
// Every page of a /cloudapi list (page is 1-based, resultTotal the count), or null when the path is not there.
function cloudList(path) {
  var sep = String(path).indexOf("?") < 0 ? "?" : "&";
  var first = cloudProbe(path + sep + "page=1&pageSize=128");
  if (first === null) return null;
  var items = first.values || [];
  var total = first.resultTotal === undefined || first.resultTotal === null ? items.length : Number(first.resultTotal);
  if (items.length >= total) return items;
  return core.pageAll(function (page) {
    if (page === 0) return { items: items, total: total };
    var b = cloudGet(path + sep + "page=" + (page + 1) + "&pageSize=128");
    return { items: b.values || [], total: total };
  }, 0);
}
function cloudSend(method, path, body) {
  return core.http(method, cloudUrl(path), CLOUD.auth, body, { contentType: CLOUD.type, accept: CLOUD.type, redact: SAFE.redact });
}
function filterOf(expression) { return "filter=" + encodeURIComponent(expression); }
function exactly(items, field, value) {
  var out = [];
  for (var i = 0; i < (items || []).length; i++) if (String(items[i][field]) === String(value)) out.push(items[i]);
  return out;
}
`;

/** Kubernetes through VCF Automation: get, create (POST, never apply), a server-side dry run. KUBE is set once logged in. */
const KUBE_JS = String.raw`var KUBE = null;
function kubeCall(method, path, body, allow, contentType) {
  return core.http(method, KUBE.base + path, KUBE.auth, body, { contentType: contentType || "application/json", allow: allow || [], redact: SAFE.redact });
}
function kubeGet(path) {
  var r = kubeCall("GET", path, null, [404]);
  return r.statusCode === 404 ? null : r.body;
}
function kubeBase(url) {
  var text = String(url || "").replace(/\/+$/, "");
  if (!/^https:\/\/[^\/?#]+/.test(text)) throw new Error("Set kubeServer in the configuration element " + SETTINGS_NAME + " to the https:// server of the namespace context (see IMPORT.md).");
  return text;
}
// Stop before anything is sent if the API group and version is not served here.
function requireServed(groupVersion) {
  var r = kubeCall("GET", "/apis/" + groupVersion, null, [404]);
  if (r.statusCode === 404) throw new Error(groupVersion + " is not served at the kubeServer configured: wrong context, or a different version on this release (kubectl api-versions).");
}
function collectionPath(apiVersion, namespace, plural) {
  var root = String(apiVersion).indexOf("/") < 0 ? "/api/" + apiVersion : "/apis/" + apiVersion;
  return root + (namespace ? "/namespaces/" + encodeURIComponent(namespace) : "") + "/" + plural;
}
// kubectl create, not apply: an object that exists is left as it is. A dry run
// asks the server to validate it (dryRun=All persists nothing), then plans it.
function ensureObject(ctx, item, label) {
  var o = item.object;
  var path = collectionPath(o.apiVersion, o.metadata.namespace, item.plural);
  var existing = kubeGet(path + "/" + encodeURIComponent(o.metadata.name));
  if (existing) {
    System.log("Exists, left as it is: " + label);
    return false;
  }
  if (ctx.dryRun) {
    kubeCall("POST", path + "?dryRun=All", o);
    System.log("Server-side dry run passed: " + label);
  }
  core.act(ctx, "create " + label, function () { return kubeCall("POST", path, o).body; });
  return !ctx.dryRun;
}
`;

/**
 * The blueprint API (VM Apps organizations): validate, create or update the
 * draft of the one template of that name in the project, then version it.
 * Mirrors import/import-templates.sh.
 */
const TEMPLATE_JS = String.raw`function importTemplate(ctx, api, auth, t) {
  var body = { name: t.name, description: t.description, projectId: t.projectId, requestScopeOrg: false, content: t.content };
  var v = core.http("POST", api + "/blueprint/api/blueprint-validation", auth, body, { allow: [400, 404, 405], redact: SAFE.redact });
  if (v.statusCode >= 200 && v.statusCode < 300 && v.body && v.body.valid === false) {
    var messages = [];
    for (var i = 0; i < (v.body.validationMessages || []).length; i++) messages.push(String(v.body.validationMessages[i].message || ""));
    throw new Error("Template " + t.name + " is not valid: " + messages.join("; "));
  }
  if (v.statusCode >= 300) System.warn("Template validation answered HTTP " + v.statusCode + "; creating it validates again.");
  var list = core.http("GET", api + "/blueprint/api/blueprints?name=" + encodeURIComponent(t.name) + "&size=200", auth, null, SAFE).body || {};
  var same = [];
  for (var j = 0; j < (list.content || []).length; j++) {
    var b = list.content[j];
    if (String(b.name) === String(t.name) && (!b.projectId || String(b.projectId) === String(t.projectId))) same.push(b);
  }
  if (same.length > 1) throw new Error("More than one template named " + t.name + " in project " + t.projectId + "; tidy them first.");
  var id = same.length === 1 ? String(same[0].id) : null;
  if (id) {
    var current = core.http("GET", api + "/blueprint/api/blueprints/" + id, auth, null, SAFE).body || {};
    if (String(current.content) === String(t.content)) System.log("Template " + t.name + " (" + id + "): the draft is already this content, left as it is.");
    else core.act(ctx, "update the draft of template " + t.name + " (" + id + ")", function () { return core.http("PUT", api + "/blueprint/api/blueprints/" + id, auth, body, SAFE).body; });
  } else {
    var made = core.act(ctx, "create template " + t.name + " in project " + t.projectId, function () {
      var r = core.http("POST", api + "/blueprint/api/blueprints", auth, body, SAFE);
      if (!r.body || !r.body.id) throw new Error("POST /blueprint/api/blueprints returned no id.");
      return String(r.body.id);
    });
    if (!made) {
      core.act(ctx, "create version " + t.version + " of template " + t.name + (t.release ? " and release it" : ""), function () { return null; });
      return null;
    }
    id = made;
  }
  var versions = core.http("GET", api + "/blueprint/api/blueprints/" + id + "/versions?size=200", auth, null, SAFE).body || {};
  for (var k = 0; k < (versions.content || []).length; k++) {
    if (String(versions.content[k].version) === String(t.version)) {
      System.log("Version " + t.version + " of " + t.name + " exists, left as it is: versions are immutable; raise the version to publish a change.");
      return id;
    }
  }
  core.act(ctx, "create version " + t.version + " of template " + t.name + (t.release ? " and release it" : ""), function () {
    return core.http("POST", api + "/blueprint/api/blueprints/" + id + "/versions", auth, { version: t.version, description: t.description, changeLog: t.changeLog || "", release: t.release === true }, SAFE).body;
  });
  return id;
}
`;

/** Where each blueprint's package goes, and its name. */
const AREA = 'Automation/VCF Automation 9.1';

const CSV_JS = String.raw`function csv(v) {
  var s = v === null || v === undefined ? "" : String(v);
  return /[",\n]/.test(s) ? "\"" + s.split("\"").join("\"\"") + "\"" : s;
}
`;

/** The provider or organization login and the /cloudapi version, in that order: no login when the version is wrong. */
const CLOUD_LOGIN_JS = String.raw`var cloudType = "application/json;version=" + pickVersion(String(settings.vcfaHost), settings.apiVersion);
var auth = core.loginVcfAutomation(String(settings.vcfaHost), settings.vcfaApiToken, ORG);
CLOUD = { host: String(settings.vcfaHost), auth: auth, type: cloudType };
`;

// --- Organization -----------------------------------------------------------

function organizationWorkflow(allApps         )         {
  return [
    LOGIN_JS('provider'),
    CLOUDAPI_JS,
    String.raw`var ALL_APPS = ${allApps ? 'true' : 'false'};
var want = JSON.parse(core.resource(RESOURCE_PATH, "org.json"));
var ctx = core.begin(settings, dryRun);
${CLOUD_LOGIN_JS}
var problems = [];
var found = cloudList("1.0.0/orgs?" + filterOf("name==" + want.name));
if (found === null) throw new Error("The organization list is not at /cloudapi/1.0.0/orgs on this release (VERIFY); nothing was created.");
var same = exactly(found, "name", want.name);
var orgId = "";
if (same.length === 0) {
  // POST /cloudapi/1.0.0/orgs, the body of Broadcom KB 419781: isClassicTenant true is VM Apps.
  orgId = core.act(ctx, "create " + (want.isClassicTenant ? "VM Apps" : "All Apps") + " organization " + want.name, function () {
    var r = cloudSend("POST", "1.0.0/orgs", want);
    if (!r.body || !r.body.id) throw new Error("POST /cloudapi/1.0.0/orgs returned no id.");
    return String(r.body.id);
  }) || "";
} else {
  orgId = String(same[0].id);
  // The type is fixed at creation; an organization of the other type is not this one.
  if (Boolean(same[0].isClassicTenant) !== Boolean(want.isClassicTenant)) throw new Error("Organization " + want.name + " exists as " + (same[0].isClassicTenant ? "VM Apps" : "All Apps") + ", and the type cannot be changed. Nothing was changed.");
  System.log("Exists, left as it is: organization " + want.name + " (" + orgId + ")");
  if (same[0].isEnabled === false) problems.push("organization " + want.name + " is disabled");
}
if (ALL_APPS && orgId) {
  var quotas = cloudList("vcf/virtualDatacenters?" + filterOf("org.id==" + orgId));
  if (quotas === null) problems.push("the region quotas could not be read (VERIFY /cloudapi/vcf/virtualDatacenters)");
  else if (quotas.length === 0) problems.push("no region quota yet: apply main.tf with Terraform for the quota, VM classes, storage policy and networking");
  else for (var q = 0; q < quotas.length; q++) {
    System.log("Region quota " + quotas[q].name + ": " + (quotas[q].status || "?"));
    if (quotas[q].status && String(quotas[q].status) !== "READY") problems.push("region quota " + quotas[q].name + " is " + quotas[q].status);
  }
} else if (ALL_APPS) {
  System.log("The region quota is checked once the organization exists.");
}
for (var p = 0; p < problems.length; p++) System.warn("PROBLEM: " + problems[p]);
organizationId = orgId;
problemCount = problems.length;
summary = core.audit(ctx, { organization: want.name, id: orgId, allApps: ALL_APPS, problems: problems });
core.notify(settings.webhook, summary);`,
  ].join('\n');
}

// --- Region inventory -------------------------------------------------------

function regionWorkflow()         {
  return [
    LOGIN_JS('provider'),
    CLOUDAPI_JS,
    String.raw`var want = JSON.parse(core.resource(RESOURCE_PATH, "region.json"));
${CLOUD_LOGIN_JS}
var problems = [];
var inv = { region: want.region };
function names(list) {
  var out = [];
  for (var i = 0; i < list.length; i++) out.push(String(list[i].name));
  return out;
}
// A list that is not where the SDK has it is a problem, so a moved path shows up rather than passing.
function listOrProblem(path, what) {
  var list = cloudList(path);
  if (list === null) problems.push(what + " could not be read (VERIFY /cloudapi/" + path.split("?")[0] + ")");
  return list;
}
var regions = cloudList("vcf/regions?" + filterOf("name==" + want.region));
if (regions === null) throw new Error("The region list is not at /cloudapi/vcf/regions on this release (VERIFY); nothing was read.");
var match = exactly(regions, "name", want.region);
if (match.length !== 1) {
  problems.push("region " + want.region + " not found");
} else {
  var region = match[0];
  var rid = String(region.id);
  inv.status = region.status || "?";
  inv.cpuCapacityMHz = region.cpuCapacityMHz === undefined ? null : region.cpuCapacityMHz;
  inv.memoryCapacityMiB = region.memoryCapacityMiB === undefined ? null : region.memoryCapacityMiB;
  System.log("Region " + want.region + ": status " + inv.status + ", " + inv.cpuCapacityMHz + " MHz, " + inv.memoryCapacityMiB + " MiB.");
  if (String(inv.status) !== "READY") problems.push("region " + want.region + " is " + inv.status);
  var byRegion = "?" + filterOf("region.id==" + rid);
  var zones = listOrProblem("vcf/zones" + byRegion, "zones");
  if (zones !== null) {
    inv.zones = names(zones);
    if (zones.length === 0) problems.push("no zones: the supervisors have none VCF Automation can use");
  }
  var supervisors = listOrProblem("vcf/supervisors" + byRegion, "supervisors");
  if (supervisors !== null) inv.supervisors = names(supervisors);
  var classes = listOrProblem("vcf/virtualMachineClasses" + byRegion, "VM classes");
  if (classes !== null) {
    inv.vmClasses = names(classes);
    for (var c = 0; c < want.expectedVmClasses.length; c++) {
      if (inv.vmClasses.indexOf(want.expectedVmClasses[c]) < 0) problems.push("VM class " + want.expectedVmClasses[c] + " is missing (make it on the supervisor in vCenter)");
    }
  }
  var policies = listOrProblem("vcf/regionStoragePolicies" + byRegion, "storage policies");
  if (policies !== null) inv.storagePolicies = names(policies);
  var storageClasses = listOrProblem("vcf/storageClasses" + byRegion, "storage classes");
  if (storageClasses !== null) inv.storageClasses = names(storageClasses);
}
for (var p = 0; p < problems.length; p++) System.warn("PROBLEM: " + problems[p]);
inventory = JSON.stringify(inv);
problemCount = problems.length;
summary = core.audit(null, { inventory: inv, problems: problems });
core.notify(settings.webhook, summary);
if (problems.length > 0) throw new Error(problems.length + " problem(s) in region " + want.region + ": " + problems.join("; ") + ".");`,
  ].join('\n');
}

// --- Tag placement ----------------------------------------------------------

function tagPlacementWorkflow(writeZones         , template                                                        )         {
  return [
    LOGIN_JS(null),
    TEMPLATE_JS,
    String.raw`var WRITE_ZONES = ${writeZones ? 'true' : 'false'};
var WANT = JSON.parse(core.resource(RESOURCE_PATH, "zone-tags.json"));
var REQUIRED = JSON.parse(core.resource(RESOURCE_PATH, "required-tags.json"));
var TEMPLATE = ${JSON.stringify(template)};
var ctx = core.begin(settings, dryRun);
var api = "https://" + settings.vcfaHost;
var auth = core.loginVcfAutomation(String(settings.vcfaHost), settings.vcfaApiToken, ORG);
// VERIFY: PATCH is what the IaaS API reference lists for a zone update; zoneMethod PUT switches it.
var ZONE_METHOD = settings.zoneMethod ? String(settings.zoneMethod).toUpperCase() : "PATCH";
if (ZONE_METHOD !== "PATCH" && ZONE_METHOD !== "PUT") throw new Error("zoneMethod is PATCH or PUT.");
function tagKey(t) { return String(t.key) + ":" + (t.value === undefined || t.value === null ? "" : String(t.value)); }
function hasTag(tags, key) {
  for (var i = 0; i < (tags || []).length; i++) if (tagKey(tags[i]) === key) return true;
  return false;
}
var zones = core.pageAll(function (page) {
  var b = core.http("GET", api + "/iaas/api/zones?$top=200&$skip=" + page * 200, auth, null, SAFE).body || {};
  return { items: b.content || [], total: b.totalElements === undefined ? null : b.totalElements };
}, 0);
var after = {};
for (var z = 0; z < zones.length; z++) after[String(zones[z].id)] = zones[z].tags || [];
var zonesChanged = [];
if (WRITE_ZONES) {
  for (var w = 0; w < WANT.length; w++) {
    var named = [];
    for (var n = 0; n < zones.length; n++) if (String(zones[n].name) === String(WANT[w].zone)) named.push(zones[n]);
    // One zone of that name, or it is skipped: two zones called Production is how production tags land on the lab.
    if (named.length !== 1) {
      System.warn("Zone \"" + WANT[w].zone + "\": " + (named.length === 0 ? "not found" : named.length + " zones have that name") + " — skipped.");
      continue;
    }
    var id = String(named[0].id);
    // The zone read fresh is both the base of the update and, in the log, what it was.
    var cur = core.http("GET", api + "/iaas/api/zones/" + id, auth, null, SAFE).body || {};
    var regionId = cur.regionId || (cur._links && cur._links.region && cur._links.region.href ? String(cur._links.region.href).split("/").pop() : "");
    if (!regionId) {
      System.warn("Zone " + WANT[w].zone + ": no region id in GET /iaas/api/zones/" + id + "; skipped rather than sending a zone without one.");
      continue;
    }
    var tags = (cur.tags || []).slice(0);
    var added = [];
    for (var t = 0; t < WANT[w].tags.length; t++) {
      if (!hasTag(tags, tagKey(WANT[w].tags[t]))) {
        tags.push(WANT[w].tags[t]);
        added.push(tagKey(WANT[w].tags[t]));
      }
    }
    after[id] = tags;
    if (added.length === 0) {
      System.log("Zone " + WANT[w].zone + ": already has every tag, left as it is.");
      continue;
    }
    System.log("Zone " + WANT[w].zone + " (" + id + ") had: " + JSON.stringify(cur.tags || []));
    // The whole zone, not only its tags: older releases require name and regionId, and a partial body can reset what it leaves out.
    var body = { name: cur.name, regionId: regionId, tags: tags };
    var keep = ["description", "placementPolicy", "folder", "customProperties", "tagsToMatch"];
    for (var k = 0; k < keep.length; k++) if (cur[keep[k]] !== undefined && cur[keep[k]] !== null) body[keep[k]] = cur[keep[k]];
    (function (zoneId, zoneBody) {
      core.act(ctx, "add capability tags " + added.join(", ") + " to zone " + WANT[w].zone, function () {
        return core.http(ZONE_METHOD, api + "/iaas/api/zones/" + zoneId, auth, zoneBody, SAFE).body;
      });
    })(id, body);
    zonesChanged.push(String(WANT[w].zone));
  }
}
// Every tag a hard constraint can ask for must be on some zone, or those requests fail placement.
var missing = [];
for (var r = 0; r < REQUIRED.length; r++) {
  var carried = false;
  for (var zid in after) if (after.hasOwnProperty(zid) && hasTag(after[zid], REQUIRED[r])) carried = true;
  if (!carried) missing.push(REQUIRED[r]);
}
for (var m = 0; m < missing.length; m++) System.warn("NO ZONE carries " + missing[m] + " — requests asking for it will fail placement.");
var templateId = "";
if (settings.projectId) {
  templateId = importTemplate(ctx, api, auth, { name: TEMPLATE.name, description: TEMPLATE.description, version: TEMPLATE.version, content: core.resource(RESOURCE_PATH, "example-template.yaml"), projectId: String(settings.projectId), release: settings.releaseTemplate === true, changeLog: "" }) || "";
} else {
  System.log("projectId is empty in " + SETTINGS_NAME + ": the example template is not imported.");
}
missingTags = missing.join(", ");
summary = core.audit(ctx, { zonesChanged: zonesChanged, missingTags: missing, templateId: templateId });
core.notify(settings.webhook, summary);
if (missing.length > 0) throw new Error(missing.length + " tag(s) a hard constraint can ask for are on no cloud zone: " + missing.join(", ") + ".");`,
  ].join('\n');
}

// --- Template versions ------------------------------------------------------

function templateVersionWorkflow()         {
  return [
    LOGIN_JS(null),
    String.raw`var T = JSON.parse(core.resource(RESOURCE_PATH, "template.json"));
var V = JSON.parse(core.resource(RESOURCE_PATH, "version.json"));
var ctx = core.begin(settings, dryRun);
var api = "https://" + settings.vcfaHost;
if (T.target) {
  if (String(T.target) === ORG) throw new Error("The target organization is the source organization; nothing to import.");
  if (!settings.targetApiToken || !settings.targetProjectId) throw new Error("Set targetApiToken and targetProjectId in " + SETTINGS_NAME + " for the import into " + T.target + ".");
}
function named(authHeader, name) {
  var list = core.http("GET", api + "/blueprint/api/blueprints?name=" + encodeURIComponent(name) + "&size=200", authHeader, null, SAFE).body || {};
  var out = [];
  for (var i = 0; i < (list.content || []).length; i++) if (String(list.content[i].name) === String(name)) out.push(list.content[i]);
  return out;
}
var auth = core.loginVcfAutomation(String(settings.vcfaHost), settings.vcfaApiToken, ORG);
// The name filter is loose; the exact match is made here, and it must be one template.
var matches = named(auth, T.name);
if (matches.length !== 1) throw new Error(matches.length === 0 ? "No template named \"" + T.name + "\" in " + ORG + "." : matches.length + " templates are named \"" + T.name + "\" in " + ORG + "; versioning one of them by name would be a guess.");
var id = String(matches[0].id);
var full = core.http("GET", api + "/blueprint/api/blueprints/" + id, auth, null, SAFE).body || {};
var content = String(full.content || "");
var versions = core.http("GET", api + "/blueprint/api/blueprints/" + id + "/versions?size=200", auth, null, SAFE).body || {};
var have = [];
for (var i = 0; i < (versions.content || []).length; i++) have.push(String(versions.content[i].version));
System.log("Template " + T.name + " (" + id + "), versions: " + (have.length ? have.join(", ") : "none"));
if (have.indexOf(String(V.version)) >= 0) {
  System.warn("Version " + V.version + " exists, left as it is: versions are immutable; pick the next number for a change.");
} else {
  core.act(ctx, "create version " + V.version + " of template " + T.name + (V.release ? " and release it to the catalog" : ""), function () {
    return core.http("POST", api + "/blueprint/api/blueprints/" + id + "/versions", auth, V, SAFE).body;
  });
}
var imported = "";
if (T.target) {
  var targetAuth = core.loginVcfAutomation(String(settings.vcfaHost), settings.targetApiToken, String(T.target));
  var there = named(targetAuth, T.name);
  if (there.length > 0) {
    System.warn("A template named \"" + T.name + "\" already exists in " + T.target + " (" + there[0].id + "), left as it is: add a version there instead of a second copy.");
    imported = String(there[0].id);
  } else {
    imported = core.act(ctx, "import template " + T.name + " into project " + settings.targetProjectId + " of " + T.target + " as a draft", function () {
      var r = core.http("POST", api + "/blueprint/api/blueprints", targetAuth, { name: T.name, description: "", projectId: String(settings.targetProjectId), requestScopeOrg: false, content: content }, SAFE);
      if (!r.body || !r.body.id) throw new Error("POST /blueprint/api/blueprints in " + T.target + " returned no id.");
      return String(r.body.id);
    }) || "";
  }
}
templateId = id;
templateYaml = content;
importedId = imported;
summary = core.audit(ctx, { template: T.name, id: id, version: V.version, released: V.release === true, target: T.target || null, importedId: imported });
core.notify(settings.webhook, summary);`,
  ].join('\n');
}

// --- Namespace day 2 --------------------------------------------------------

function namespaceDay2Workflow(ns        )         {
  return [
    LOGIN_JS(null),
    String.raw`var NS = ${JSON.stringify(ns)};
var PATCH = JSON.parse(core.resource(RESOURCE_PATH, "patch.json"));
if (!settings.project) throw new Error("Set project in " + SETTINGS_NAME + ": the VCF Automation project the namespace " + NS + " belongs to.");
var ctx = core.begin(settings, dryRun);
var auth = core.loginVcfAutomation(String(settings.vcfaHost), settings.vcfaApiToken, ORG);
// SupervisorNamespace objects of an All Apps organization (go-vcloud-director ccitypes: KubernetesSubpath + SupervisorNamespacesURL).
var url = "https://" + settings.vcfaHost + "/cci/kubernetes/apis/infrastructure.cci.vmware.com/v1alpha3/namespaces/" + encodeURIComponent(String(settings.project)) + "/supervisornamespaces/" + encodeURIComponent(NS);
var MERGE = { contentType: "application/merge-patch+json", redact: SAFE.redact };
function covers(have, want) {
  if (want === null || typeof want !== "object") return have !== undefined && have !== null && String(have) === String(want);
  if (Object.prototype.toString.call(want) === "[object Array]") {
    if (!have || have.length !== want.length) return false;
    for (var i = 0; i < want.length; i++) if (!covers(have[i], want[i])) return false;
    return true;
  }
  if (!have || typeof have !== "object") return false;
  for (var k in want) if (want.hasOwnProperty(k) && !covers(have[k], want[k])) return false;
  return true;
}
var r = core.http("GET", url, auth, null, { allow: [404], redact: SAFE.redact });
if (r.statusCode === 404) throw new Error("Namespace " + NS + " is not in project " + settings.project + "; not changing what could not be read and saved.");
// The namespace as it was is the undo: it is the before output, and in the log.
before = r.text;
System.log("Namespace " + NS + " before the change: " + r.text);
var patched = false;
if (covers(r.body, PATCH)) {
  System.log("Namespace " + NS + " already has every value in patch.json, left as it is.");
} else {
  // A server-side dry run every time, before the real patch: quota and class checks happen on the server.
  core.http("PATCH", url + "?dryRun=All", auth, PATCH, MERGE);
  System.log("Server-side dry run passed.");
  core.act(ctx, "patch namespace " + NS + " with patch.json: " + JSON.stringify(PATCH.spec), function () {
    return core.http("PATCH", url, auth, PATCH, MERGE).body;
  });
  patched = !ctx.dryRun;
}
summary = core.audit(ctx, { namespace: NS, project: String(settings.project), patched: patched });
core.notify(settings.webhook, summary);`,
  ].join('\n');
}

// --- Estate health check ----------------------------------------------------

function estateWorkflow()         {
  return [
    LOGIN_JS('provider'),
    CLOUDAPI_JS,
    String.raw`var WARN_DAYS = Number(settings.expiryWarnDays || 14);
${CLOUD_LOGIN_JS}
var problems = [];
var counts = {};
// Each list: every page, and a path that is not there is a problem rather than a silent pass.
function check(path, what, bad) {
  var list = cloudList(path);
  if (list === null) {
    problems.push(what + ": could not be read (VERIFY /cloudapi/" + path.split("?")[0] + ")");
    return;
  }
  counts[what] = list.length;
  System.log(what + ": " + list.length);
  for (var i = 0; i < list.length; i++) {
    var why = bad(list[i]);
    if (why) problems.push(what + " " + list[i].name + " " + why);
  }
}
function notReady(o) { return o.status && String(o.status) !== "READY" ? "is " + o.status : null; }
var now = new Date().getTime();
check("1.0.0/orgs", "organizations", function (o) { return o.isEnabled === false ? "is disabled" : null; });
check("vcf/regions", "regions", notReady);
check("vcf/virtualDatacenters", "region quotas", notReady);
check("vcf/contentLibraries", "content libraries", function (o) { return notReady(o) ? notReady(o) + " (subscribed library 401s are a 9.1.1 known issue)" : null; });
check("1.0.0/tokens?" + filterOf("type==REFRESH"), "API tokens", function (o) {
  if (!o.expirationDate) return null;
  var at = Date.parse(String(o.expirationDate));
  return !isNaN(at) && at - now < WARN_DAYS * 86400000 ? "expires within " + WARN_DAYS + " days (" + o.expirationDate + ")" : null;
});
for (var p = 0; p < problems.length; p++) System.warn("PROBLEM: " + problems[p]);
problemCount = problems.length;
summary = core.audit(null, { counts: counts, problems: problems });
core.notify(settings.webhook, summary);
if (problems.length > 0) throw new Error(problems.length + " problem(s): " + problems.join("; ") + ".");
System.log("All checks passed.");`,
  ].join('\n');
}

// --- Content library check --------------------------------------------------

function libraryWorkflow()         {
  return [
    LOGIN_JS(null),
    CLOUDAPI_JS,
    CSV_JS,
    String.raw`var LIB = JSON.parse(core.resource(RESOURCE_PATH, "library.json")).name;
${CLOUD_LOGIN_JS}
var problems = [];
var rows = ["name,type,imageIdentifier,status"];
var libs = cloudList("vcf/contentLibraries?" + filterOf("name==" + LIB));
if (libs === null) throw new Error("The content library list is not at /cloudapi/vcf/contentLibraries on this release (VERIFY); nothing was read.");
var match = exactly(libs, "name", LIB);
if (match.length === 0) problems.push("library " + LIB + " not found");
else if (match.length > 1) problems.push("more than one library named " + LIB + " is visible; check which one VM Service uses");
if (match.length > 0) {
  var lib = match[0];
  System.log("Library " + LIB + ": status " + (lib.status || "?") + ", type " + (lib.libraryType || "?") + ", subscribed " + (lib.isSubscribed === true) + ".");
  if (String(lib.status || "") !== "READY") problems.push("library " + LIB + " is " + (lib.status || "of unknown status"));
  var items = cloudList("vcf/contentLibraryItems?" + filterOf("contentLibrary.id==" + lib.id));
  if (items === null) problems.push("the items could not be read (VERIFY /cloudapi/vcf/contentLibraryItems)");
  else for (var i = 0; i < items.length; i++) {
    var it = items[i];
    rows.push([csv(it.name), csv(it.itemType || "?"), csv(it.imageIdentifier || ""), csv(it.status || "?")].join(","));
    if (it.status && String(it.status) !== "READY") problems.push("item " + it.name + " is " + it.status);
  }
}
for (var p = 0; p < problems.length; p++) System.warn("PROBLEM: " + problems[p]);
itemReport = rows.join("\n") + "\n";
problemCount = problems.length;
summary = core.audit(null, { library: LIB, items: rows.length - 1, problems: problems });
core.notify(settings.webhook, summary);
if (problems.length > 0) throw new Error(problems.length + " problem(s) with content library " + LIB + ": " + problems.join("; ") + ".");`,
  ].join('\n');
}

// --- Kubernetes objects in a namespace ---------------------------------------

/**
 * The workflow of every "create these Kubernetes objects" automation: log in,
 * check each API group is served, run the automation's own checks, then
 * create each object that does not exist, in order.
 */
function kubeWorkflow(opts                                                                                                                   )         {
  return [
    LOGIN_JS(null),
    KUBE_JS,
    String.raw`var items = JSON.parse(core.resource(RESOURCE_PATH, ${JSON.stringify(opts.resource)}));
var ctx = core.begin(settings, dryRun);
var base = kubeBase(settings.kubeServer);
var auth = core.loginVcfAutomation(String(settings.vcfaHost), settings.vcfaApiToken, ORG);
KUBE = { base: base, auth: auth };
var SERVED = ${JSON.stringify(opts.served)};
for (var g = 0; g < SERVED.length; g++) requireServed(SERVED[g]);
${opts.pre ?? ''}
var created = [];
for (var i = 0; i < items.length; i++) {
  var o = items[i].object;
  var label = ${opts.label ?? 'o.kind + " " + o.metadata.name + (o.metadata.namespace ? " in " + o.metadata.namespace : "")'};
  if (ensureObject(ctx, items[i], label)) created.push(o.kind + "/" + o.metadata.name);
}
createdObjects = created.join(", ");
summary = core.audit(ctx, { kubeServer: base, created: created });
core.notify(settings.webhook, summary);`,
  ].join('\n');
}

/** The settings of a workflow that creates namespace objects. */
function kubeConfig(what        , org        , cap        , extra                                                                                                                                              = []) {
  return {
    name: 'Settings',
    description: `Settings of the ${what} workflow. Fill kubeServer and vcfaApiToken after import; set dryRun to false only after a dry run.`,
    attributes: [VCFA_HOST_ATTR, ORG_ATTR(org), TOKEN_ATTR('a project member of the organization'), KUBE_ATTR, ...extra, ...GUARD_ATTRS(cap), WEBHOOK_ATTR],
  };
}

const KUBE_OUTPUTS = [
  { name: 'createdObjects', type: 'string', description: 'What this run created, kind/name; empty in a dry run' },
  { name: 'summary', type: 'string', description: 'The audit record, JSON' },
];
const DRY_RUN_INPUT = { name: 'dryRun', type: 'boolean', description: 'true: validate on the server and report what would be created; change nothing' };

const KUBE_VERIFY =
  'VERIFY: the namespace objects go to kubeServer, the Kubernetes API server of the namespace context that `vcf context create --type cci` writes into the kubeconfig, with the bearer token from the organization API token exchange. The server URL is copied from the kubeconfig rather than built, because the path behind it is not in Broadcom documentation; that the endpoint takes the exchanged token (as the vcf CLI context does) is the part to verify on first use — a 401 says so.';

// --- API tokens -------------------------------------------------------------

function tokensWorkflow(org               , revoke         )         {
  return [
    LOGIN_JS(org),
    CLOUDAPI_JS,
    CSV_JS,
    String.raw`var WARN_DAYS = Number(settings.expiryWarnDays || 30);
${revoke ? 'var ctx = core.begin(settings, dryRun);' : 'var ctx = null;'}
${CLOUD_LOGIN_JS}
var tokens = cloudList("1.0.0/tokens?" + filterOf("type==REFRESH"));
if (tokens === null) throw new Error("The token list is not at /cloudapi/1.0.0/tokens on this release; nothing was audited (VERIFY the path).");
var now = new Date().getTime();
var rows = ["name,owner,expires,id"];
var soon = [];
for (var i = 0; i < tokens.length; i++) {
  var t = tokens[i];
  rows.push([csv(t.name), csv(t.owner && t.owner.name ? t.owner.name : "?"), csv(t.expirationDate || "never"), csv(t.id)].join(","));
  if (t.expirationDate) {
    var at = Date.parse(String(t.expirationDate));
    if (!isNaN(at) && at - now < WARN_DAYS * 86400000) soon.push(String(t.name));
  }
}
System.log(tokens.length + " API token(s); " + soon.length + " expire within " + WARN_DAYS + " days" + (soon.length ? ": " + soon.join(", ") : "") + ".");
var revoked = "";
${
  revoke
    ? String.raw`if (revokeId) {
  if (!revokeName) throw new Error("Give revokeName as well: a token is revoked only when its id and its exact name both match.");
  var target = cloudProbe("1.0.0/tokens/" + encodeURIComponent(String(revokeId)));
  if (target === null) throw new Error("No token " + revokeId + ". Nothing was revoked.");
  if (String(target.name) !== String(revokeName)) throw new Error("Token " + revokeId + " is named \"" + target.name + "\", not \"" + revokeName + "\". Nothing was revoked.");
  core.act(ctx, "revoke API token \"" + target.name + "\" (" + revokeId + ", owner " + (target.owner && target.owner.name ? target.owner.name : "?") + "); whatever still uses it fails at its next exchange", function () {
    return cloudSend("DELETE", "1.0.0/tokens/" + encodeURIComponent(String(revokeId)), null).statusCode;
  });
  if (!ctx.dryRun) revoked = String(revokeId);
}`
    : ''
}
tokenReport = rows.join("\n") + "\n";
expiringCount = soon.length;
summary = core.audit(ctx, { tokens: tokens.length, expiring: soon, warnDays: WARN_DAYS, revoked: revoked });
core.notify(settings.webhook, summary);
if (soon.length > 0${revoke ? ' && !revokeId' : ''}) throw new Error(soon.length + " API token(s) expire within " + WARN_DAYS + " days: " + soon.join(", ") + ". Make a replacement, put it in the configuration elements that use the old one, then revoke the old one.");`,
  ].join('\n');
}

// ---------------------------------------------------------------------------

const CORE_91                                 = [
  // -------------------------------------------------------------------------
  automationBlueprint({
    id: 'vcfa91_api_tokens',
    platform: PLATFORM,
    label: 'Provider and organization API tokens: exchange, audit, rotate, revoke',
    group: 'VCF Automation 9.1 — access',
    description:
      'The VCF Automation 9 way in: an API token made in the interface (My Account → API Tokens), exchanged at /oauth/provider/token or /oauth/tenant/{org}/token for a one-hour bearer token that is written to a mode-600 file other scripts read. Handles token rotation, audits expiring tokens, and revokes one by id and exact name.',
    inputs: [
      {
        id: 'scope',
        label: 'Token for',
        control: 'select',
        options: [
          { value: 'tenant', label: 'An organization — /oauth/tenant/{org}/token' },
          { value: 'provider', label: 'The provider (System) — /oauth/provider/token' },
        ],
        default: 'tenant',
      },
      { id: 'org', label: 'Organization', control: 'text', default: 'team-a', hint: 'The name in its login URL', showWhen: { input: 'scope', equals: ['tenant'] } },
      { id: 'token_file', label: 'API token file', control: 'text', default: '/etc/vcf-automation/vcfa-api-token', hint: 'Mode 600, owned by the account that runs the scripts' },
      { id: 'access_file', label: 'Write the access token to', control: 'text', default: '/run/vcf-automation/vcfa-access-token', hint: 'Other scripts read VCFA_TOKEN from here' },
      { id: 'expiry_warn_days', label: 'Warn when a token expires within (days)', control: 'number', default: 30, min: 1, max: 365 },
      { id: 'schedule_refresh', label: 'Refresh the access token every 45 minutes', control: 'toggle', default: true },
      { id: 'include_revoke', label: 'Include the revoke script', control: 'toggle', default: false },
    ],
    automation: (values                 , name        )             => {
      const scope = (str(values, 'scope', 'tenant') === 'provider' ? 'provider' : 'tenant')         ;
      const org = str(values, 'org', 'team-a');
      const tokenFile = str(values, 'token_file', '/etc/vcf-automation/vcfa-api-token');
      const accessFile = str(values, 'access_file', '/run/vcf-automation/vcfa-access-token');
      const warnDays = num(values, 'expiry_warn_days', 30);
      const schedule = bool(values, 'schedule_refresh', true);
      const revoke = bool(values, 'include_revoke', false);
      const tokenPath = scope === 'provider' ? '/oauth/provider/token' : `/oauth/tenant/${org}/token`;
      void name;

      const findings            = [];
      if (scope === 'provider') {
        findings.push(
          warning('vcfa91.token.provider', 'A provider API token acts as the service provider administrator, across every organization.', {
            remediation: 'Use an organization token wherever the work is inside one organization. Keep provider tokens for provider objects — organizations, regions, quotas — and give each one its own file and owner.',
            source: SRC,
          }),
        );
      }
      if (scope === 'tenant' && !LABEL.test(org.toLowerCase())) {
        findings.push(warning('vcfa91.token.org-name', `"${org}" does not look like an organization login name.`, { remediation: 'Use the name in the organization’s login URL, not its display name.', source: SRC }));
      }
      if (/^\/tmp\/|^\/var\/tmp\//.test(tokenFile)) {
        findings.push(warning('vcfa91.token.tmp', 'The API token file is under a shared temporary directory.', { remediation: 'Keep it under /etc or the service account’s home, mode 600. A temporary directory is cleaned, and on some hosts shared.', source: SRC }));
      }
      findings.push(
        info('vcfa91.token.rotation', 'If the organization has API token rotation on, every exchange returns a new API token and the old one stops working.', {
          remediation: 'The exchange script writes the new token back to the file before it does anything else. That only works if one job owns the file — two jobs sharing one token file with rotation on will lock each other out.',
          source: SRC,
        }),
      );

      const exchange = [
        '#!/usr/bin/env bash',
        `# Exchange the VCF Automation API token for a one-hour access token, at ${tokenPath}.`,
        '#',
        '# The access token is written, mode 600, to ACCESS_FILE; other scripts take it with',
        '#   export VCFA_TOKEN="$(cat <ACCESS_FILE>)"',
        '# The API token itself is read from VCFA_API_TOKEN_FILE and sent on stdin.',
        'set -euo pipefail',
        '',
        `ACCESS_FILE="\${VCFA_ACCESS_FILE:-${accessFile}}"`,
        ...(scope === 'tenant' ? [`VCFA_ORG="\${VCFA_ORG:-${org}}"`] : []),
        'unset VCFA_TOKEN',
        ...authLines(scope),
        '',
        'mkdir -p "$(dirname "$ACCESS_FILE")"',
        '( umask 077; printf \'%s\\n\' "$VCFA_TOKEN" > "${ACCESS_FILE}.new" ) && mv "${ACCESS_FILE}.new" "$ACCESS_FILE"',
        '',
        '# Print when it expires, from the JWT, without printing the token.',
        "P=$(cut -d. -f2 <<<\"$VCFA_TOKEN\" | tr '_-' '/+')",
        'while (( ${#P} % 4 )); do P="${P}="; done',
        "EXP=$(base64 -d <<<\"$P\" 2>/dev/null | jq -r '.exp // empty' 2>/dev/null || true)",
        'if [[ -n "$EXP" ]]; then',
        '  echo "Access token written to $ACCESS_FILE; expires $(date -d "@$EXP" 2>/dev/null || date -r "$EXP")"',
        'else',
        '  echo "Access token written to $ACCESS_FILE (lifetime about one hour)"',
        'fi',
        '',
        '# Undo: nothing to undo. To stop it working, revoke the API token (vcfa-token-revoke.sh or My Account → API Tokens).',
        '',
      ].join('\n');

      const audit = restScript({
        purpose: `List the API tokens this ${scope === 'provider' ? 'provider' : 'organization'} account can see and flag any expiring within ${warnDays} days.`,
        scope,
        act: false,
        body: [
          `WARN_DAYS=${warnDays}`,
          '# VERIFY: /cloudapi/1.0.0/tokens is the Cloud Director token API VCF Automation inherited;',
          '# an organization user sees their own tokens, an administrator the organization’s.',
          "LIST=$(probe '/cloudapi/1.0.0/tokens?filter=type==REFRESH&pageSize=128') || exit 2",
          'NOW=$(date +%s)',
          "jq -r --argjson now \"$NOW\" --argjson warn \"$WARN_DAYS\" '",
          '  .values[]? | [.name, (.owner.name // "?"), (.id), (.expirationDate // "never")] | @tsv\' <<<"$LIST" |',
          "  awk -F'\\t' 'BEGIN{printf \"%-32s %-24s %-28s %s\\n\",\"NAME\",\"OWNER\",\"EXPIRES\",\"ID\"} {printf \"%-32s %-24s %-28s %s\\n\",$1,$2,$4,$3}'",
          "SOON=$(jq -r --argjson now \"$NOW\" --argjson warn \"$WARN_DAYS\" '",
          '  [.values[]? | select(.expirationDate != null) | select(((.expirationDate | sub("\\\\.[0-9]+"; "") | sub("(?<z>[+-][0-9]{2}:[0-9]{2}|Z)$"; "Z") | fromdateiso8601) - $now) < ($warn * 86400)) | .name] | join(", ")\' <<<"$LIST")',
          'if [[ -n "$SOON" ]]; then',
          '  echo "Expiring within ${WARN_DAYS} days: ${SOON}. Make a replacement, swap the file, then revoke the old one."',
          '  exit 1',
          'fi',
          'echo "No token expires within ${WARN_DAYS} days."',
        ],
      });

      const revokeScript = restScript({
        purpose: 'Revoke one API token, by id, only when its name matches exactly.',
        scope,
        act: true,
        body: [
          'ID="${1:-}"; NAME="${2:-}"',
          '[[ -n "$ID" && -n "$NAME" && "$ID" != --dry-run && "$NAME" != --dry-run ]] || { echo "usage: $0 <token-id> <exact-token-name> [--dry-run]   (ids from vcfa-tokens-audit.sh)" >&2; exit 2; }',
          'TOKEN_JSON=$(probe "/cloudapi/1.0.0/tokens/${ID}") || exit 2',
          "ACTUAL=$(jq -r '.name' <<<\"$TOKEN_JSON\")",
          '[[ "$ACTUAL" == "$NAME" ]] || { echo "Token ${ID} is named \\"${ACTUAL}\\", not \\"${NAME}\\". Nothing revoked." >&2; exit 2; }',
          "echo \"Token: ${ACTUAL}, owner $(jq -r '.owner.name // \"?\"' <<<\"$TOKEN_JSON\")\"",
          'if (( DRY_RUN )); then',
          '  echo "DRY RUN: would DELETE /cloudapi/1.0.0/tokens/${ID}. Anything still using it will fail at its next exchange."',
          'else',
          '  curl -sS -f -K <(auth_cfg) -X DELETE "https://${VCFA_HOST}/cloudapi/1.0.0/tokens/${ID}" -H "Accept: $(cloudapi_type)"',
          '  echo "Revoked ${ACTUAL}."',
          'fi',
        ],
        undo: 'none — a revoked API token cannot be restored. Make a new one in My Account → API Tokens and replace the file.',
      });

      const env = `VCFA_HOST=vcfa.example.com${scope === 'tenant' ? ` VCFA_ORG=${org}` : ''} VCFA_API_TOKEN_FILE=${tokenFile} VCFA_ACCESS_FILE=${accessFile}`;

      // In Orchestrator the exchange is core.loginVcfAutomation on every run, so
      // the package is the audit (and, when asked for, the revoke).
      const pkg = toPackage({
        packageName: packageNameOf('vcfa91', 'tokens', scope === 'provider' ? 'provider' : org),
        description: `Audits the VCF Automation API tokens of ${scope === 'provider' ? 'the provider account' : `an account in organization ${org}`}${revoke ? ', and revokes one by id and exact name' : ''}.`,
        categoryPath: `${AREA}/API tokens/${scope === 'provider' ? 'provider' : org}`,
        workflow: {
          name: 'Audit VCF Automation API tokens',
          description: `Exchanges the API token at ${tokenPath} (which proves it still works, and warns when rotation replaced it), lists the account's API tokens and flags those expiring within the configured days; fails the run when one does, so a schedule alerts.${revoke ? ' With revokeId and revokeName, revokes that one token — only when both match, and not when the dryRun input is true.' : ''}`,
          inputs: revoke
            ? [
                { name: 'dryRun', type: 'boolean', description: 'true: report what would be revoked and change nothing' },
                { name: 'revokeId', type: 'string', description: 'The id of the token to revoke (from the report); empty to only audit' },
                { name: 'revokeName', type: 'string', description: 'Its exact name; nothing is revoked unless it matches' },
              ]
            : [],
          outputs: [
            { name: 'tokenReport', type: 'string', description: 'CSV: name, owner, expires, id' },
            { name: 'expiringCount', type: 'number', description: 'Tokens expiring within the warning period' },
            { name: 'summary', type: 'string', description: 'The audit record, JSON' },
          ],
          script: tokensWorkflow(scope === 'provider' ? 'provider' : null, revoke),
        },
        config: {
          name: 'Settings',
          description: 'Settings of the Audit VCF Automation API tokens workflow. Fill vcfaApiToken after import.',
          attributes: [
            VCFA_HOST_ATTR,
            ...(scope === 'provider' ? [] : [ORG_ATTR(org)]),
            TOKEN_ATTR(scope === 'provider' ? 'a provider administrator' : `the account in ${org}`),
            API_VERSION_ATTR,
            { name: 'expiryWarnDays', type: 'number', value: warnDays, description: 'Flag tokens expiring within this many days' },
            ...(revoke ? GUARD_ATTRS(1) : []),
            WEBHOOK_ATTR,
          ],
        },
      });

      const files                         = {
        ...pkg.files,
        'IMPORT.md': importMd({
          subject: `The API token handling every other VCF Automation 9 automation on this page authenticates with: an Orchestrator workflow that audits the account's API tokens${revoke ? ' and revokes one' : ''}, and the scripts that exchange, audit${revoke ? ' and revoke' : ''} from a Linux host. Nothing is imported into VCF Automation itself.`,
          orgs: scope === 'provider' ? PROVIDER : 'VCF Automation 9.1 / 9.1.1 organizations, VM Apps and All Apps',
          steps: [
            manualStep('Make the API token', [`Log in to https://<vcfa>/${scope === 'provider' ? 'provider' : `tenant/${org}`}, My Account → API Tokens → New. It is shown once: paste it into the configuration element (step 4 below), or for the scripts write it to a mode-600 file: \`( umask 077; cat > ${tokenFile} )\`, paste, Ctrl-D.`]),
            ...pkg.importSteps,
            manualStep('Or from a Linux host — exchange it', ['`./scripts/vcfa-token-exchange.sh` writes a one-hour access token to the access file. The import scripts (`import/*.sh`) take the API token file directly as VCFA_API_TOKEN_FILE with VCFA_ORG; `apply.sh` scripts take VCFA_TOKEN="$(cat <access file>)".']),
            checkStep('vcfa-tokens-audit.sh', `tokens that expire within ${warnDays} days.`),
          ],
          auth: ['vcfa91'],
          verify: [
            'The exchange (/oauth/tenant/<org>/token, /oauth/provider/token, grant_type=refresh_token) is from Broadcom TechDocs 9.1 and vrealize.it, "VCF Automation 9 API Access".',
            'VERIFY: /cloudapi/1.0.0/tokens (list, GET and DELETE by id) and its fields name, owner.name and expirationDate come from the Cloud Director token API VCF Automation inherited (go-vcloud-director OpenApiEndpointTokens); a 404 is reported, never read as "no tokens".',
            'VERIFY: with token rotation on, the exchange returns a new API token and the configuration element still holds the old one; the workflow warns, and the SecureString has to be replaced by hand (core.loginVcfAutomation cannot write it back).',
          ],
        }),
        'scripts/vcfa-token-exchange.sh': exchange,
        'scripts/vcfa-tokens-audit.sh': audit,
        ...(revoke ? { 'scripts/vcfa-token-revoke.sh': revokeScript } : {}),
        ...(schedule ? { 'crontab.txt': cronLine('*/45 * * * *', env, 'vcfa-token-exchange.sh', 'vcfa-token.log') } : {}),
        'rotation-runbook.txt': [
          'Rotating a VCF Automation API token without an outage',
          '',
          `1. Log in to https://<vcfa>/${scope === 'provider' ? 'provider' : `tenant/${org}`} as the account the token belongs to.`,
          '2. My Account → API Tokens → NEW. Name it with the date, e.g. vcf-2026-09. Copy it once;',
          '   it is not shown again.',
          `3. Write it to ${tokenFile}.new with umask 077, then mv it over ${tokenFile}.`,
          '4. Run scripts/vcfa-token-exchange.sh by hand and confirm it writes the access token. In',
          '   Orchestrator: replace vcfaApiToken in every configuration element that holds the old one.',
          '5. Wait one scheduled cycle, then list tokens with the Audit VCF Automation API tokens workflow',
          `   (or scripts/vcfa-tokens-audit.sh) and revoke the old one by id and exact name${revoke ? ' with the workflow\'s revokeId and revokeName, or scripts/vcfa-token-revoke.sh' : ' (enable the revoke option, or use My Account → API Tokens)'}.`,
          '',
          'If the organization has token rotation on, step 3 is done for you on every exchange: the',
          'script writes the new token back. Do not copy the file to a second machine in that case.',
          '',
        ].join('\n'),
      };

      return {
        platform: PLATFORM,
        title: `VCF Automation 9 API token handling — ${scope === 'provider' ? 'provider' : `organization ${org}`}`,
        effect: revoke ? 'irreversible' : 'reversible',
        trigger: {
          kind: schedule ? 'schedule' : 'manual',
          detail: schedule ? 'Every 45 minutes from cron, so the one-hour access token is always fresh; the audit and revoke scripts by hand.' : 'Run by hand, or by whatever job needs a token first.',
          worstCase: schedule ? '32 exchanges a day, each of which rotates the API token if rotation is on' : undefined,
        },
        scope: {
          what: `One API token of one ${scope === 'provider' ? 'provider administrator' : `user in organization ${org}`}, and the access token made from it.`,
          decidedBy: [
            'Whose token it is: an API token carries that user’s roles, no more and no less.',
            scope === 'provider' ? 'The provider scope: the System organization, which administers every organization.' : `The organization in the URL, ${org}.`,
            'The revoke script: exactly the one token whose id and name are both given.',
          ],
          ifWrong: 'A token of a highly privileged user left in a file is that user for anyone who can read the file. A revoke of the wrong token stops whatever used it at its next exchange, usually the nightly job.',
        },
        guardrails: [
          { rule: 'The API token file must be mode 600 or 400, or the scripts stop', because: 'A world-readable token file is a standing credential for anyone with a shell on the host.' },
          { rule: 'The API token is sent on stdin, and the bearer token to curl on a file descriptor', because: 'Neither shows in ps, /proc or the shell history.' },
          { rule: 'A rotated API token is written back atomically before anything else', because: 'With rotation on, the old token dies at the exchange; losing the new one means a trip to the interface and a failed night of jobs.' },
          { rule: 'In Orchestrator the API token is a SecureString, redacted from every error and never logged', because: 'The workflow log is readable by everyone who can see the workflow run.' },
          ...(revoke ? [{ rule: 'Revoke needs the id and the exact name, and revokes at most one per run', because: 'Two tokens called "automation" on one account is common; revoking by name alone takes the wrong one.' }] : []),
        ],
        dryRun: [
          'The Audit VCF Automation API tokens workflow only reads unless a revoke is asked for; scripts/vcfa-tokens-audit.sh the same from a Linux host.',
          ...(revoke ? ['Run the workflow with the dryRun input set to true to preview: the log says which token it would revoke. scripts/vcfa-token-revoke.sh --dry-run does the same.'] : []),
          'The exchange has no dry run — the exchange is the operation. With rotation on it replaces the API token file every time.',
        ],
        undo: [
          'An exchange needs no undo: the access token expires within the hour.',
          'A revoked API token cannot be restored. Create a new one and replace the file.',
        ],
        told: ['VCF Automation records token creation and use against the user in its event log.', 'The workflow log and its AUDIT lines, the summary output, and the webhook when one is set; a run with tokens about to expire fails.', schedule ? 'The cron log, /var/log/vcf-automation/vcfa-token.log.' : 'The terminal it was run in.'],
        requires: [
          'VCF Automation 9.x, with the account the token belongs to able to log in to the portal.',
          'An API token made in My Account → API Tokens, in the configuration element (Orchestrator) or the token file (scripts).',
          'Orchestrator in VCF Automation 9.1 (or VCF Operations orchestrator 9.1) with the VCF Automation certificate trusted; or curl and jq on a Linux host for the scripts.',
        ],
        files,
        notes: [
          'Provider: POST https://<vcfa>/oauth/provider/token. Organization: POST https://<vcfa>/oauth/tenant/<org>/token. Both form-encoded grant_type=refresh_token&refresh_token=<API token>, Accept: application/*; the answer has access_token and token_type Bearer, valid one hour (Broadcom TechDocs, 9.1).',
          'Which login to use: /iaas/api/login with a refresh token is the 8.x method, still answered for VM Apps organizations upgraded from 8.x. A fresh 9.x organization — VM Apps or All Apps — authenticates like a tenant, at /oauth/tenant/<org>/token (vrealize.it, VCF Automation 9 API Access). When unsure, try the OAuth exchange first.',
          'The /cloudapi calls send Accept: application/json;version=<version>. The workflow uses apiVersion when set (refused if GET /api/versions does not list it), otherwise the newest version listed; the scripts use VCFA_API_VERSION, default 9.1.0. Broadcom KB 419781 uses 40.0 on 9.0, vrealize.it uses 9.0.0 — GET /api/versions is the authority.',
          'Service accounts (Administration → Access Control → Service Accounts) use the OAuth device flow at /oauth/tenant/<org>/device_authorization and then the same token endpoint. The Terraform provider reads their token with service_account_token_file.',
          'The token list and revoke calls use /cloudapi/1.0.0/tokens, inherited from Cloud Director. VERIFY on your release: the probe prints the HTTP status if the path moved.',
          'The vcf CLI takes the token as --api-token. Omit it and let the CLI ask, so it does not land in history.',
        ],
        findings,
      };
    },
  }),

  // -------------------------------------------------------------------------
  automationBlueprint({
    id: 'vcfa91_organization',
    platform: PLATFORM,
    label: 'A tenant organization: All Apps or VM Apps, region quota and networking',
    group: 'VCF Automation 9.1 — provider',
    description:
      'Provider portal work as Terraform (vmware/vcfa): the organization, whether it is All Apps or VM Apps (classic), and for All Apps its region quota — supervisors, per-zone CPU and memory, VM classes, storage policy limit — and regional networking through a provider gateway. With a read-only check and the onboarding checklist for everything that is still a click.',
    inputs: [
      { id: 'org_name', label: 'Organization name', control: 'text', default: 'team-a', hint: 'Becomes the login URL; lower case' },
      { id: 'display_name', label: 'Display name', control: 'text', default: 'Team A' },
      {
        id: 'org_type',
        label: 'Type',
        control: 'select',
        options: [
          { value: 'all-apps', label: 'All Apps — VMs, Kubernetes, VPCs, Supervisor services' },
          { value: 'vm-apps', label: 'VM Apps — the 8.x-style organization (classic tenant)' },
        ],
        default: 'all-apps',
      },
      { id: 'region', label: 'Region', control: 'text', default: 'region1', showWhen: { input: 'org_type', equals: ['all-apps'] } },
      { id: 'vcenter', label: 'vCenter', control: 'text', default: 'vcenter-wld01', showWhen: { input: 'org_type', equals: ['all-apps'] } },
      { id: 'supervisors', label: 'Supervisors', control: 'text', default: 'supervisor-wld01', hint: 'Comma separated; 9.1 allows a quota across several', showWhen: { input: 'org_type', equals: ['all-apps'] } },
      { id: 'zones', label: 'Zones', control: 'text', default: 'zone-a', hint: 'Each gets the CPU and memory below', showWhen: { input: 'org_type', equals: ['all-apps'] } },
      { id: 'cpu_limit_mhz', label: 'CPU limit per zone (MHz)', control: 'number', default: 100000, min: 0, max: 100000000, showWhen: { input: 'org_type', equals: ['all-apps'] } },
      { id: 'cpu_reservation_mhz', label: 'CPU reservation per zone (MHz)', control: 'number', default: 0, min: 0, max: 100000000, showWhen: { input: 'org_type', equals: ['all-apps'] } },
      { id: 'memory_limit_mib', label: 'Memory limit per zone (MiB)', control: 'number', default: 262144, min: 0, max: 1000000000, showWhen: { input: 'org_type', equals: ['all-apps'] } },
      { id: 'memory_reservation_mib', label: 'Memory reservation per zone (MiB)', control: 'number', default: 0, min: 0, max: 1000000000, showWhen: { input: 'org_type', equals: ['all-apps'] } },
      { id: 'vm_classes', label: 'VM classes', control: 'text', default: 'best-effort-small, best-effort-medium, best-effort-large', showWhen: { input: 'org_type', equals: ['all-apps'] } },
      { id: 'storage_policy', label: 'Storage policy', control: 'text', default: 'vSAN Default Storage Policy', showWhen: { input: 'org_type', equals: ['all-apps'] } },
      { id: 'storage_limit_gib', label: 'Storage limit (GiB)', control: 'number', default: 2048, min: 0, max: 10000000, showWhen: { input: 'org_type', equals: ['all-apps'] } },
      { id: 'provider_gateway', label: 'Provider gateway', control: 'text', default: 'provider-gw-01', showWhen: { input: 'org_type', equals: ['all-apps'] } },
      { id: 'edge_cluster', label: 'Edge cluster', control: 'text', default: '', hint: 'Empty lets VCF Automation pick', showWhen: { input: 'org_type', equals: ['all-apps'] } },
      { id: 'admin_group', label: 'Organization administrators (group)', control: 'text', default: 'vcfa-team-a-admins' },
      {
        id: 'identity',
        label: 'Identity source',
        control: 'select',
        options: [
          { value: 'oidc', label: 'OIDC — VCF Identity Broker or another IdP' },
          { value: 'ldap', label: 'LDAP / Active Directory' },
          { value: 'saml', label: 'SAML 2.0' },
        ],
        default: 'oidc',
      },
      { id: 'oidc_wellknown', label: 'OIDC well-known endpoint', control: 'text', default: 'https://idb.example.com/acs/t/CUSTOMER/.well-known/openid-configuration', section: 'Identity', showWhen: { input: 'identity', equals: ['oidc'] } },
      { id: 'oidc_client_id', label: 'OIDC client id', control: 'text', default: 'vcfa-team-a', hint: 'The secret comes from TF_VAR_oidc_client_secret', section: 'Identity', showWhen: { input: 'identity', equals: ['oidc'] } },
      { id: 'oidc_groups_claim', label: 'Groups claim', control: 'text', default: 'groups', section: 'Identity', showWhen: { input: 'identity', equals: ['oidc'] } },
      { id: 'ldap_server', label: 'LDAP server', control: 'text', default: 'ad01.example.com', section: 'Identity', showWhen: { input: 'identity', equals: ['ldap'] } },
      {
        id: 'ldap_connector',
        label: 'Directory',
        control: 'select',
        options: [
          { value: 'ACTIVE_DIRECTORY', label: 'Active Directory' },
          { value: 'OPEN_LDAP', label: 'OpenLDAP' },
        ],
        default: 'ACTIVE_DIRECTORY',
        section: 'Identity',
        showWhen: { input: 'identity', equals: ['ldap'] },
      },
      { id: 'ldap_base_dn', label: 'Base DN', control: 'text', default: 'DC=example,DC=com', section: 'Identity', showWhen: { input: 'identity', equals: ['ldap'] } },
      { id: 'ldap_bind_user', label: 'Bind account', control: 'text', default: 'CN=svc-vcfa,OU=Service,DC=example,DC=com', hint: 'The password comes from TF_VAR_ldap_bind_password', section: 'Identity', showWhen: { input: 'identity', equals: ['ldap'] } },
      { id: 'saml_metadata_url', label: 'SAML metadata URL', control: 'text', default: 'https://idp.example.com/saml/metadata', section: 'Identity', showWhen: { input: 'identity', equals: ['saml'] } },
      { id: 'avi_lb', label: 'Delegate Avi load balancing (9.1)', control: 'toggle', default: true, section: '9.1 delegation and networking', showWhen: { input: 'org_type', equals: ['all-apps'] } },
      { id: 'avi_lb_quota', label: 'Load balancer quota (virtual services)', control: 'number', default: 10, min: 0, max: 10000, section: '9.1 delegation and networking', showWhen: { input: 'avi_lb', equals: ['true'] } },
      { id: 'dfw', label: 'Delegate vDefend distributed firewall (9.1)', control: 'toggle', default: true, section: '9.1 delegation and networking', showWhen: { input: 'org_type', equals: ['all-apps'] } },
      { id: 'gateway_fw', label: 'Delegate vDefend gateway firewall (9.1)', control: 'toggle', default: true, section: '9.1 delegation and networking', showWhen: { input: 'org_type', equals: ['all-apps'] } },
      {
        id: 'external_connections',
        label: 'External connections (9.1: several)',
        control: 'textarea',
        default: 'internet | provider-gw-01 | region1-external',
        hint: 'name | provider gateway or connection | external IP block',
        section: '9.1 delegation and networking',
        showWhen: { input: 'org_type', equals: ['all-apps'] },
      },
      { id: 'shared_vlan_subnets', label: 'Shared VLAN extension subnets', control: 'text', default: '', hint: 'Comma separated provider subnets to share with the organization', section: '9.1 delegation and networking', showWhen: { input: 'org_type', equals: ['all-apps'] } },
      { id: 'private_vpc_block', label: 'Default private VPC IP block', control: 'text', default: '10.64.0.0/16', section: '9.1 delegation and networking', showWhen: { input: 'org_type', equals: ['all-apps'] } },
      { id: 'tgw_private_block', label: 'Transit gateway private IP block', control: 'text', default: '172.20.0.0/20', section: '9.1 delegation and networking', showWhen: { input: 'org_type', equals: ['all-apps'] } },
    ],
    automation: (values                 , name        )             => {
      const orgName = str(values, 'org_name', 'team-a');
      const display = str(values, 'display_name', orgName);
      const allApps = str(values, 'org_type', 'all-apps') === 'all-apps';
      const region = str(values, 'region', 'region1');
      const vcenter = str(values, 'vcenter', 'vcenter-wld01');
      const supervisors = listOf(str(values, 'supervisors', 'supervisor-wld01'));
      const zones = listOf(str(values, 'zones', 'zone-a'));
      const cpuLimit = num(values, 'cpu_limit_mhz', 100000);
      const cpuRes = num(values, 'cpu_reservation_mhz', 0);
      const memLimit = num(values, 'memory_limit_mib', 262144);
      const memRes = num(values, 'memory_reservation_mib', 0);
      const vmClasses = listOf(str(values, 'vm_classes', ''));
      const storagePolicy = str(values, 'storage_policy', 'vSAN Default Storage Policy');
      const storageGib = num(values, 'storage_limit_gib', 2048);
      const gateway = str(values, 'provider_gateway', 'provider-gw-01');
      const edge = str(values, 'edge_cluster', '');
      const adminGroup = str(values, 'admin_group', '');
      const identity = str(values, 'identity', 'oidc');
      const tf = label(orgName, 'org').replace(/-/g, '_');
      const avi = allApps && bool(values, 'avi_lb', true);
      const aviQuota = num(values, 'avi_lb_quota', 10);
      const dfw = allApps && bool(values, 'dfw', true);
      const gatewayFw = allApps && bool(values, 'gateway_fw', true);
      const externals = allApps
        ? str(values, 'external_connections', '')
            .split('\n')
            .map((l) => l.trim())
            .filter((l) => l && !l.startsWith('#'))
            .map((l) => {
              const [cname = '', via = '', block = ''] = l.split('|').map((c) => c.trim());
              return { name: cname, via, block, line: l };
            })
        : [];
      const sharedVlans = allApps ? listOf(str(values, 'shared_vlan_subnets', '')) : [];
      const privateVpcBlock = allApps ? str(values, 'private_vpc_block', '') : '';
      const tgwBlock = allApps ? str(values, 'tgw_private_block', '') : '';
      void name;

      const findings            = [];
      if (!LABEL.test(orgName)) {
        findings.push(error('vcfa91.org.name', `"${orgName}" is not usable as an organization name: it becomes the login URL.`, { remediation: 'Lower case letters, digits and hyphens, starting and ending with a letter or digit.', source: SRC }));
      }
      if (allApps) {
        if (supervisors.length === 0) findings.push(error('vcfa91.org.no-supervisor', 'A region quota needs at least one supervisor.', { source: SRC }));
        if (zones.length === 0) findings.push(error('vcfa91.org.no-zone', 'A region quota needs at least one zone allocation.', { source: SRC }));
        if (cpuLimit === 0 || memLimit === 0 || storageGib === 0) {
          findings.push(warning('vcfa91.org.zero-limit', 'A limit of 0 is set; check whether that means none or nothing on your release.', { remediation: 'Give each zone an explicit CPU and memory limit and the storage policy an explicit limit. An unbounded organization can take the whole region.', source: SRC }));
        }
        if (cpuRes > cpuLimit || memRes > memLimit) {
          findings.push(error('vcfa91.org.reservation', 'A reservation is larger than its limit.', { remediation: 'Reservations are carved out of the limit. Lower the reservation or raise the limit.', source: SRC }));
        }
        if (vmClasses.length === 0) {
          findings.push(warning('vcfa91.org.no-vm-classes', 'No VM classes are granted, so nothing in the organization can make a VM or a VKS node.', { source: SRC }));
        }
        if (supervisors.length > 1) {
          findings.push(info('vcfa91.org.multi-supervisor', 'The quota spans several supervisors — new in 9.1, and only on 9.1.', { remediation: 'On a 9.0 system the second supervisor is rejected. Upgrade VCF Automation first.', source: SRC }));
        }
      } else {
        findings.push(
          info('vcfa91.org.vm-apps', 'A VM Apps organization gets no region quota or regional networking here — it places through cloud accounts and cloud zones, as in 8.x.', {
            remediation: 'After it exists: "A vSphere cloud account", "A cloud zone with a placement policy" and "A project with groups, quotas and a naming template" in this kit, run with that organization’s token.',
            source: SRC,
          }),
        );
      }
      if (!adminGroup) {
        findings.push(warning('vcfa91.org.no-admin', 'No administrator group is named, so the organization is administered only by the provider.', { source: SRC }));
      }
      if (identity === 'oidc' && !/^https:\/\/\S+\/\.well-known\/openid-configuration$/.test(str(values, 'oidc_wellknown', ''))) {
        findings.push(warning('vcfa91.org.oidc-wellknown', 'The OIDC endpoint should be the https:// …/.well-known/openid-configuration URL of the identity provider.', { source: SRC }));
      }
      if (identity === 'saml') findings.push(info('vcfa91.org.saml', 'SAML is set in the provider portal: the vmware/vcfa provider has no SAML resource at 1.2.x (VERIFY).', { remediation: 'onboarding-checklist.md has the steps; OIDC through the VCF Identity Broker is the route the Terraform covers.', source: SRC }));
      if (allApps) {
        for (const e of externals) {
          if (!e.name || !e.via) findings.push(error('vcfa91.org.external', `Could not read the external connection "${e.line}".`, { remediation: 'name | provider gateway or connection | external IP block', source: SRC }));
        }
        if (externals.length > 1) findings.push(info('vcfa91.org.multi-external', `${externals.length} external connections: new in 9.1; each transit gateway of the organization attaches to one.`, { source: SRC }));
        for (const [what, cidr] of [['default private VPC', privateVpcBlock], ['transit gateway private', tgwBlock]]         ) {
          if (!cidr) continue;
          if (familyOf(cidr) === 6) findings.push(error('vcfa91.org.private-ipv6', `The ${what} IP block ${cidr} is IPv6; NSX VPC private blocks are IPv4.`, { source: SRC }));
          else if (familyOf(cidr) !== 4 || !cidr.includes('/')) findings.push(error('vcfa91.org.private-cidr', `The ${what} IP block "${cidr}" is not an IPv4 CIDR.`, { source: SRC }));
        }
        if (avi && aviQuota === 0) findings.push(warning('vcfa91.org.avi-zero', 'Avi load balancing is delegated with a quota of 0, so no load balancer can be created.', { source: SRC }));
        if (gatewayFw && !dfw) findings.push(info('vcfa91.org.gw-only', 'Gateway firewall is delegated without the distributed firewall: the organization can filter north-south but not between its own VMs.', { source: SRC }));
      }

      const main = [
        `# Organization ${orgName} — ${allApps ? 'All Apps' : 'VM Apps (classic tenant)'}.`,
        '# Provider work: run with VCFA_ORG=System and a provider API token.',
        '',
        `resource "vcfa_org" "${tf}" {`,
        `  name         = ${q(orgName)}`,
        `  display_name = ${q(display)}`,
        '  description  = "Managed by Terraform"',
        '  is_enabled   = true',
        `  # true makes a VM Apps (classic) organization. It cannot be changed afterwards.`,
        `  is_classic_tenant = ${allApps ? 'false' : 'true'}`,
        '',
        '  lifecycle {',
        '    # Destroying an organization deletes everything in it. Remove this line on purpose, not by accident.',
        '    prevent_destroy = true',
        '  }',
        '}',
        '',
        ...(allApps
          ? [
              `data "vcfa_vcenter" "vc" {`,
              `  name = ${q(vcenter)}`,
              '}',
              '',
              `data "vcfa_region" "region" {`,
              `  name = ${q(region)}`,
              '}',
              '',
              ...supervisors.flatMap((s, i) => [`data "vcfa_supervisor" "sv${i}" {`, `  name       = ${q(s)}`, '  vcenter_id = data.vcfa_vcenter.vc.id', '}', '']),
              ...zones.flatMap((z, i) => [`data "vcfa_region_zone" "z${i}" {`, '  region_id = data.vcfa_region.region.id', `  name      = ${q(z)}`, '}', '']),
              ...vmClasses.flatMap((c, i) => [`data "vcfa_region_vm_class" "c${i}" {`, '  region_id = data.vcfa_region.region.id', `  name      = ${q(c)}`, '}', '']),
              'data "vcfa_region_storage_policy" "sp" {',
              '  region_id = data.vcfa_region.region.id',
              `  name      = ${q(storagePolicy)}`,
              '}',
              '',
              `resource "vcfa_org_region_quota" "${tf}" {`,
              `  org_id         = vcfa_org.${tf}.id`,
              '  region_id      = data.vcfa_region.region.id',
              `  supervisor_ids = [${supervisors.map((_, i) => `data.vcfa_supervisor.sv${i}.id`).join(', ')}]`,
              ...zones.flatMap((_, i) => [
                '',
                '  zone_resource_allocations {',
                `    region_zone_id         = data.vcfa_region_zone.z${i}.id`,
                `    cpu_limit_mhz          = ${cpuLimit}`,
                `    cpu_reservation_mhz    = ${cpuRes}`,
                `    memory_limit_mib       = ${memLimit}`,
                `    memory_reservation_mib = ${memRes}`,
                '  }',
              ]),
              '',
              `  region_vm_class_ids = [${vmClasses.map((_, i) => `data.vcfa_region_vm_class.c${i}.id`).join(', ')}]`,
              '',
              '  region_storage_policy {',
              '    region_storage_policy_id = data.vcfa_region_storage_policy.sp.id',
              `    storage_limit_mib        = ${storageGib * 1024}`,
              '  }',
              '}',
              '',
              'data "vcfa_provider_gateway" "gw" {',
              `  name      = ${q(gateway)}`,
              '  region_id = data.vcfa_region.region.id',
              '}',
              '',
              ...(edge ? ['data "vcfa_edge_cluster" "edge" {', `  name      = ${q(edge)}`, '  region_id = data.vcfa_region.region.id', '}', ''] : []),
              `resource "vcfa_org_networking" "${tf}" {`,
              `  org_id   = vcfa_org.${tf}.id`,
              `  # Short name used in NSX object names. VERIFY the length limit on your release.`,
              `  log_name = ${q(label(orgName, 'org').replace(/-/g, '').slice(0, 8))}`,
              '}',
              '',
              `resource "vcfa_org_regional_networking" "${tf}" {`,
              `  name                = ${q(`${label(orgName, 'org')}-${label(region, 'region')}`)}`,
              `  # The networking resource's id carries the org id, which orders the two correctly.`,
              `  org_id              = vcfa_org_networking.${tf}.id`,
              '  provider_gateway_id = data.vcfa_provider_gateway.gw.id',
              '  region_id           = data.vcfa_region.region.id',
              ...(edge ? ['  edge_cluster_id     = data.vcfa_edge_cluster.edge.id'] : ['  # edge_cluster_id left out: VCF Automation picks one.']),
              '}',
              '',
            ]
          : []),
      ].join('\n');

      // Identity: OIDC or LDAP through the vmware/vcfa provider, the secret from a TF_VAR_ environment variable.
      const ad = str(values, 'ldap_connector', 'ACTIVE_DIRECTORY') === 'ACTIVE_DIRECTORY';
      const identityTf =
        identity === 'oidc'
          ? [
              `# OIDC for ${orgName}. The client secret comes from TF_VAR_oidc_client_secret, never from this file.`,
              'variable "oidc_client_secret" {',
              '  type      = string',
              '  sensitive = true',
              '}',
              '',
              `resource "vcfa_org_oidc" "${tf}" {`,
              `  org_id             = vcfa_org.${tf}.id`,
              '  enabled            = true',
              `  client_id          = ${q(str(values, 'oidc_client_id', ''))}`,
              '  client_secret      = var.oidc_client_secret',
              `  wellknown_endpoint = ${q(str(values, 'oidc_wellknown', ''))}`,
              '  scopes             = ["openid", "profile", "email", "groups"]',
              '  prefer_id_token    = false',
              '',
              '  claims_mapping {',
              '    subject    = "sub"',
              '    email      = "email"',
              '    first_name = "given_name"',
              '    last_name  = "family_name"',
              '    full_name  = "name"',
              `    groups     = ${q(str(values, 'oidc_groups_claim', 'groups'))}`,
              '  }',
              '}',
              '',
            ].join('\n')
          : identity === 'ldap'
            ? [
                `# LDAP for ${orgName}. The bind password comes from TF_VAR_ldap_bind_password, never from this file.`,
                'variable "ldap_bind_password" {',
                '  type      = string',
                '  sensitive = true',
                '}',
                '',
                `resource "vcfa_org_ldap" "${tf}" {`,
                `  org_id    = vcfa_org.${tf}.id`,
                '  ldap_mode = "CUSTOM"',
                '',
                '  custom_settings {',
                `    server                  = ${q(str(values, 'ldap_server', ''))}`,
                '    port                    = 636',
                '    is_ssl                  = true',
                `    connector_type          = ${q(ad ? 'ACTIVE_DIRECTORY' : 'OPEN_LDAP')}`,
                `    base_distinguished_name = ${q(str(values, 'ldap_base_dn', ''))}`,
                '    authentication_method   = "SIMPLE"',
                `    username                = ${q(str(values, 'ldap_bind_user', ''))}`,
                '    password                = var.ldap_bind_password',
                '',
                '    user_attributes {',
                `      object_class                = ${q(ad ? 'user' : 'inetOrgPerson')}`,
                `      unique_identifier           = ${q(ad ? 'objectGuid' : 'entryUUID')}`,
                `      username                    = ${q(ad ? 'sAMAccountName' : 'uid')}`,
                '      email                       = "mail"',
                '      display_name                = "displayName"',
                '      given_name                  = "givenName"',
                '      surname                     = "sn"',
                '      telephone                   = "telephoneNumber"',
                '      group_membership_identifier = "dn"',
                '    }',
                '',
                '    group_attributes {',
                `      object_class          = ${q(ad ? 'group' : 'groupOfUniqueNames')}`,
                `      unique_identifier     = ${q(ad ? 'objectGuid' : 'entryUUID')}`,
                '      name                  = "cn"',
                `      membership            = ${q(ad ? 'member' : 'uniqueMember')}`,
                '      membership_identifier = "dn"',
                '    }',
                '  }',
                '}',
                '',
              ].join('\n')
            : '';

      // The 9.1 organization settings: delegation, external connections, shared VLAN subnets, private blocks.
      const ORG_PATH = 'vcf/orgs/{orgId}';
      const settings91 = allApps
        ? [
            ...(avi ? [{ what: `Avi load balancing, quota ${aviQuota}`, path: `${ORG_PATH}/loadBalancerSettings`, body: { enabled: true, virtualServiceQuota: aviQuota }, manual: `Provider portal → Organizations → ${orgName} → Networking → Load Balancing: enable, quota ${aviQuota} virtual services.` }] : []),
            ...(dfw || gatewayFw
              ? [{ what: `vDefend delegation (distributed ${dfw ? 'on' : 'off'}, gateway ${gatewayFw ? 'on' : 'off'})`, path: `${ORG_PATH}/securitySettings`, body: { distributedFirewallEnabled: dfw, gatewayFirewallEnabled: gatewayFw }, manual: `Provider portal → Organizations → ${orgName} → Networking → Security: Distributed Firewall ${dfw ? 'on' : 'off'}, Gateway Firewall ${gatewayFw ? 'on' : 'off'}.` }]
              : []),
            ...externals
              .filter((e) => e.name && e.via)
              .map((e) => ({ what: `external connection ${e.name}`, path: `${ORG_PATH}/externalConnections`, body: { name: e.name, providerGateway: e.via, ...(e.block ? { ipBlock: e.block } : {}) }, manual: `Provider portal → Organizations → ${orgName} → Networking → External Connections → Add: ${e.name}, through ${e.via}${e.block ? `, IP block ${e.block}` : ''}.` })),
            ...(sharedVlans.length ? [{ what: `shared VLAN extension subnets ${sharedVlans.join(', ')}`, path: `${ORG_PATH}/sharedSubnets`, body: { subnets: sharedVlans }, manual: `Provider portal → Networking → Shared Subnets → ${sharedVlans.join(', ')} → Share with ${orgName}.` }] : []),
            ...(privateVpcBlock || tgwBlock
              ? [{ what: 'default private VPC and transit gateway IP blocks', path: `${ORG_PATH}/networkingDefaults`, body: { ...(privateVpcBlock ? { defaultPrivateVpcIpBlock: privateVpcBlock } : {}), ...(tgwBlock ? { transitGatewayPrivateIpBlock: tgwBlock } : {}) }, manual: `Provider portal → Organizations → ${orgName} → Networking → Regional networking ${region}: private VPC block ${privateVpcBlock || '(default)'}, transit gateway block ${tgwBlock || '(default)'}.` }]
              : []),
          ]
        : [];
      const apply91 = restScript({
        purpose: `Apply the 9.1 delegation and networking settings of organization ${orgName}.`,
        scope: 'provider',
        act: true,
        checkVersion: true,
        body: [
          'cd "$(dirname "$0")/.."',
          `ORG=${q(orgName)}`,
          'O=$(probe "/cloudapi/1.0.0/orgs?filter=name==${ORG}") || exit 2',
          "ORG_ID=$(jq -r '.values[0].id // empty' <<<\"$O\")",
          '[[ -n "$ORG_ID" ]] || { echo "Organization ${ORG} does not exist yet: apply main.tf first." >&2; exit 1; }',
          '# Each setting is written only where its path answers on this release; otherwise the portal steps are printed.',
          "jq -c '.[]' org-91-settings.json | while IFS= read -r S; do",
          "  WHAT=$(jq -r .what <<<\"$S\")",
          "  P=$(jq -r --arg id \"$ORG_ID\" '.path | sub(\"[{]orgId[}]\"; $id)' <<<\"$S\")",
          '  if CUR=$(probe "/cloudapi/${P}" 2>/dev/null); then',
          '    F=$(mktemp)',
          "    if [[ \"$(jq -r '.values | type' <<<\"$CUR\")\" == array ]]; then",
          "      NAME=$(jq -r '.body.name // empty' <<<\"$S\")",
          "      if [[ -n \"$NAME\" ]] && jq -e --arg n \"$NAME\" '[.values[] | select(.name == $n)] | length > 0' <<<\"$CUR\" >/dev/null; then echo \"Exists, left as it is: ${WHAT}\"; rm -f \"$F\"; continue; fi",
          "      jq .body <<<\"$S\" > \"$F\"; send POST \"/cloudapi/${P}\" \"$F\"",
          '    else',
          "      jq --argjson want \"$(jq .body <<<\"$S\")\" '. * $want' <<<\"$CUR\" > \"$F\"",
          "      if [[ \"$(jq -S . <<<\"$CUR\")\" == \"$(jq -S . \"$F\")\" ]]; then echo \"Already set: ${WHAT}\"; else send PUT \"/cloudapi/${P}\" \"$F\"; fi",
          '    fi',
          '    rm -f "$F"',
          '  else',
          "    echo \"NO API on this release for ${WHAT} (VERIFY /cloudapi/${P}). By hand: $(jq -r .manual <<<\"$S\")\"",
          '  fi',
          'done',
        ],
        undo: 'set the same settings back in the provider portal (Organizations → <org> → Networking); withdrawing a delegation stops new objects, it does not delete existing ones.',
      });

      const check = restScript({
        purpose: `Check organization ${orgName} exists, is enabled${allApps ? ', and its region quota is READY' : ''}.`,
        scope: 'provider',
        act: false,
        checkVersion: true,
        body: [
          `ORG=${q(orgName)}`,
          'PROBLEMS=0',
          "O=$(probe \"/cloudapi/1.0.0/orgs?filter=name==${ORG}\") || exit 2",
          "COUNT=$(jq '.values | length' <<<\"$O\")",
          '[[ "$COUNT" == 1 ]] || { echo "Organization ${ORG}: not found"; exit 1; }',
          "jq -r '.values[0] | \"Organization \\(.name): enabled=\\(.isEnabled) classic(VM Apps)=\\(.isClassicTenant // \"?\") id=\\(.id)\"' <<<\"$O\"",
          "[[ \"$(jq -r '.values[0].isEnabled' <<<\"$O\")\" == true ]] || { echo \"  not enabled\"; PROBLEMS=$((PROBLEMS+1)); }",
          ...(allApps
            ? [
                "ORG_ID=$(jq -r '.values[0].id' <<<\"$O\")",
                '# Region quotas are virtual datacenters underneath: /cloudapi/vcf/virtualDatacenters (go-vcloud-director tm_region_quota.go).',
                'if Q=$(probe "/cloudapi/vcf/virtualDatacenters?filter=org.id==${ORG_ID}"); then',
                "  jq -r '.values[]? | \"  quota \\(.name): \\(.status // \"?\")\"' <<<\"$Q\"",
                "  BAD=$(jq '[.values[]? | select(.status != \"READY\")] | length' <<<\"$Q\")",
                "  [[ \"$(jq '.values | length' <<<\"$Q\")\" -gt 0 ]] || { echo '  no region quota'; PROBLEMS=$((PROBLEMS+1)); }",
                '  (( BAD == 0 )) || PROBLEMS=$((PROBLEMS+BAD))',
                'fi',
              ]
            : []),
          'exit $(( PROBLEMS > 0 ? 1 : 0 ))',
        ],
      });

      const checklist = [
        `# Onboarding ${display} (${orgName})`,
        '',
        `Type: ${allApps ? 'All Apps' : 'VM Apps (classic)'}. Terraform creates the organization${allApps ? ', its region quota and its regional networking' : ''}; the rest is below.`,
        '',
        '## Provider',
        '',
        `- [ ] \`plan.sh --dry-run\`, read the plan, then \`plan.sh\` to apply it. Then \`check-org.sh\`.`,
        identity === 'saml'
          ? `- [ ] Identity: SAML is not in the Terraform (VERIFY: no vmware/vcfa SAML resource at 1.2.x). Provider portal → Organizations → ${orgName} → Identity Providers → SAML → Configure: import the metadata from ${str(values, 'saml_metadata_url', '<metadata URL>')}, download the service provider metadata and register it at the IdP.`
          : `- [ ] Identity: identity.tf connects ${identity === 'oidc' ? 'OIDC (vcfa_org_oidc)' : 'LDAP (vcfa_org_ldap)'} for ${orgName} in the same plan; export ${identity === 'oidc' ? 'TF_VAR_oidc_client_secret' : 'TF_VAR_ldap_bind_password'} from your vault before plan.sh.`,
        `- [ ] Import the group ${adminGroup || '<administrators>'} and give it the Organization Administrator role. VERIFY: the vcfa provider has no group resource at 1.2.x; do it in the portal.`,
        ...(allApps
          ? [
              '- [ ] Content: share a provider content library with the organization, or let it make its own (see "Content libraries and VM images").',
              '- [ ] Networking: confirm the default VPC `<region>-default-vpc` exists and has the external and private IP blocks you meant (9.1: default private VPC and TGW blocks are set per provider).',
              `- [ ] 9.1 delegation and networking: \`scripts/apply-org-91.sh\` sets ${settings91.map((x) => x.what).join('; ') || 'nothing (none chosen)'} — where this release has no API for one it prints the portal steps instead.`,
            ]
          : [
              '- [ ] Cloud account, cloud zone and project: the VM Apps blueprints in this kit, run with this organization’s token.',
            ]),
        '',
        '## Organization administrator',
        '',
        '- [ ] Create an API token for automation (My Account → API Tokens) under a service identity, not a person.',
        ...(allApps
          ? [
              '- [ ] Create projects and namespace classes; set which VM classes, storage classes and zones each class allows.',
              '- [ ] Create one namespace per project and environment; confirm limits in vCenter.',
            ]
          : ['- [ ] Projects, catalogue content sources and sharing, approval policies.']),
        '- [ ] Record the organization in the CMDB with its owner and cost centre.',
        '',
      ].join('\n');

      const orgBody = { name: orgName, displayName: display, description: '', isEnabled: true, canManageOrgs: false, isClassicTenant: !allApps };
      const pkg = toPackage({
        packageName: packageNameOf('vcfa91', 'org', orgName),
        description: `Creates the ${allApps ? 'All Apps' : 'VM Apps'} organization ${orgName} in VCF Automation 9.1 if it does not exist${allApps ? ', and checks its region quota' : ''}.`,
        categoryPath: `${AREA}/Organizations/${orgName}`,
        workflow: {
          name: `Create organization ${label(orgName, 'org')}`,
          description: `Provider work. Creates the organization ${orgName} (${allApps ? 'All Apps' : 'VM Apps'}) through POST /cloudapi/1.0.0/orgs when no organization of that name exists; leaves an existing one as it is and refuses one of the other type.${allApps ? ' Then reports whether its region quota exists and is READY — the quota, VM classes, storage policy and networking are applied with the Terraform in main.tf.' : ''} Set the dryRun input to true to preview without changing anything.`,
          inputs: [{ name: 'dryRun', type: 'boolean', description: 'true: report what would be created and change nothing' }],
          outputs: [
            { name: 'organizationId', type: 'string', description: 'The organization id, empty when a dry run would create it' },
            { name: 'problemCount', type: 'number', description: 'Things that need attention: disabled, no quota, quota not READY' },
            { name: 'summary', type: 'string', description: 'The audit record, JSON' },
          ],
          script: organizationWorkflow(allApps),
        },
        config: {
          name: 'Settings',
          description: 'Settings of the organization workflow. Fill vcfaApiToken (a provider API token) after import; set dryRun to false only after a dry run.',
          attributes: [VCFA_HOST_ATTR, TOKEN_ATTR('a provider administrator'), API_VERSION_ATTR, ...GUARD_ATTRS(1), WEBHOOK_ATTR],
        },
        resources: [{ name: 'org.json', content: json(orgBody) }],
      });

      return {
        platform: PLATFORM,
        title: `Organization ${orgName} (${allApps ? 'All Apps' : 'VM Apps'})`,
        effect: 'reversible',
        trigger: { kind: 'manual', detail: 'A provider administrator onboarding a tenant runs plan.sh, reads the plan, and applies it.' },
        scope: {
          what: allApps ? `Organization ${orgName}, its quota in region ${region} across ${supervisors.length} supervisor(s) and ${zones.length} zone(s), and its regional networking through ${gateway}.` : `Organization ${orgName}, VM Apps.`,
          decidedBy: [
            'The Terraform state in the directory plan.sh runs in: it manages exactly the resources in main.tf.',
            ...(allApps ? [`The region ${region}, the supervisors named, and the zones named.`, `The VM classes (${vmClasses.length}) and the storage policy ${storagePolicy}.`, `The provider gateway ${gateway}, whose IP blocks the organization will draw from.`] : []),
          ],
          ifWrong: 'An organization given the wrong supervisor or no limits takes capacity other tenants were counting on; the first sign is their namespaces failing to schedule.',
        },
        guardrails: [
          { rule: 'Apply only the saved plan (plan.sh applies tfplan and nothing else; --dry-run stops after the plan)', because: 'A plan re-made at apply time can differ from the one that was reviewed.' },
          { rule: 'prevent_destroy on the organization', because: 'A terraform destroy, or a rename that forces replacement, would delete every namespace and VM in it.' },
          ...(settings91.length > 0 ? [{ rule: 'apply-org-91.sh writes a 9.1 setting only where its path answers, merges into what is there and never deletes', because: 'A guessed path is not written blindly, and a delegation someone widened in the portal is not narrowed by a rerun.' }] : []),
          ...(identityTf ? [{ rule: 'The identity secret is a sensitive Terraform variable read from TF_VAR_, never in a .tf file', because: 'The .tf files go into version control.' }] : []),
          ...(allApps && cpuLimit > 0 && memLimit > 0 && storageGib > 0 ? [{ rule: `Explicit limits: ${cpuLimit} MHz and ${memLimit} MiB per zone, ${storageGib} GiB of ${storagePolicy}`, because: 'Without limits one tenant can consume the region.' }] : []),
          { rule: 'The workflow and check-org.sh stop if the server does not offer the API version they ask for', because: 'A version mismatch returns fields renamed or missing, and the check reports a healthy organization it did not read.' },
          { rule: 'The workflow creates the organization only when none of that name exists, refuses one of the other type, and makes at most cap changes', because: 'The type (VM Apps or All Apps) cannot be changed after creation; a second organization of the same name is not possible and a retry must not try.' },
        ],
        dryRun: ['Run the workflow with the dryRun input set to true to preview: it reads, and logs "DRY RUN: would create organization …".', 'scripts/plan.sh --dry-run: terraform plan, saved to tfplan, changes nothing.', 'scripts/check-org.sh reads only.'],
        undo: [
          allApps ? 'Region quota and networking: remove them from main.tf and apply. Namespaces using the quota must be deleted first.' : 'Nothing but the organization was created.',
          'The organization: remove prevent_destroy on purpose, then terraform destroy -target. That deletes everything the organization contains.',
        ],
        told: ['VCF Automation provider events record who created or changed the organization.', 'The workflow log (AUDIT lines, PROBLEM warnings), its summary output and the webhook when set.', 'The Terraform state and whatever holds it.'],
        requires: [
          'VCF Automation 9.1 with the region, supervisors, zones and provider gateway already set up (see "Regions, zones and supervisors").',
          'Terraform 1.5+, network access to registry.terraform.io or a mirror, and a provider API token.',
        ],
        files: {
          ...pkg.files,
          'versions.tf': VERSIONS_TF,
          'main.tf': main,
          ...(identityTf ? { 'identity.tf': identityTf } : {}),
          ...(settings91.length > 0 ? { 'org-91-settings.json': json(settings91), 'scripts/apply-org-91.sh': apply91 } : {}),
          'org.json': json(orgBody),
          'scripts/plan.sh': tfScript(`Create organization ${orgName}.`, 'remove the resource from main.tf and apply; see the README for the organization itself.'),
          'scripts/check-org.sh': check,
          'onboarding-checklist.md': checklist,
          'IMPORT.md': importMd({
            subject: `The organization ${orgName}${allApps ? ' and its region quota' : ''}: an Orchestrator workflow that creates the organization through the /cloudapi API${allApps ? ' and checks its quota' : ''}, and the vmware/vcfa Terraform for the whole of it.`,
            orgs: PROVIDER,
            steps: [
              ...pkg.importSteps,
              allApps
                ? tfStep('The region quota, VM classes, storage policy and networking — Terraform', `Run it with VCFA_ORG=System and a provider API token. If the workflow already created the organization, first \`terraform import vcfa_org.${tf} ${orgName}\` so Terraform manages it rather than making a second one. Run the workflow again afterwards: its problemCount goes to 0 once the quota is READY.`)
                : tfStep('Or: the organization with Terraform', 'Run it with VCFA_ORG=System and a provider API token. It is the same organization; use one route or the other, or terraform import what the workflow created.'),
              manualStep('Or by the API, by hand', ['POST https://<vcfa>/cloudapi/1.0.0/orgs with `org.json` as the body, Accept and Content-Type `application/json;version=<version from GET /api/versions>`, and a provider bearer token (Broadcom KB 419781).']),
              checkStep('check-org.sh', `the organization is enabled${allApps ? ' and its region quota READY' : ''}.`),
              ...(identityTf ? [manualStep('Identity', [`identity.tf is part of the same Terraform run: export ${identity === 'oidc' ? 'TF_VAR_oidc_client_secret' : 'TF_VAR_ldap_bind_password'} from your vault first. The saved plan (tfplan) holds that value while it exists; plan.sh deletes it after the apply.`])] : []),
              ...(settings91.length > 0
                ? [manualStep('The 9.1 delegation and networking settings', ['`VCFA_HOST=… VCFA_API_TOKEN_FILE=<provider token file> ./scripts/apply-org-91.sh` (`--dry-run` to preview) sets each of org-91-settings.json where this release answers the path, merging into what is there, and prints the portal steps for any it cannot.'])]
                : []),
              manualStep('Then', ['Work through onboarding-checklist.md; the tenant-side blueprints on this page start once the organization has an administrator and an API token.']),
            ],
            auth: ['terraform', 'vcfa91'],
            verify: [
              'Creating an organization: POST /cloudapi/1.0.0/orgs with name, displayName, description, isEnabled, canManageOrgs and isClassicTenant (true = VM Apps) is Broadcom KB 419781 (VCF Automation 9.0); the same TmOrg fields are in the go-vcloud-director v3 SDK. VERIFY on 9.1 with a dry run and GET /api/versions.',
              ...(allApps ? ['Region quotas are read at /cloudapi/vcf/virtualDatacenters (go-vcloud-director govcd/tm_region_quota.go: OpenApiPathVcf + virtualDatacenters/); earlier versions of this kit read /cloudapi/1.0.0/virtualDatacenters, which is not where the SDK has them.'] : []),
              'Terraform arguments follow the vmware/vcfa provider documentation (1.2.x, which states support for 9.1).',
              ...(identityTf ? [`VERIFY: ${identity === 'oidc' ? 'vcfa_org_oidc (client_id, client_secret, wellknown_endpoint, scopes, claims_mapping)' : 'vcfa_org_ldap (ldap_mode CUSTOM, custom_settings with user_attributes and group_attributes)'} follows the Cloud Director provider resource it was ported from; check the argument names in the vmware/vcfa documentation for your provider version.`] : []),
              ...(settings91.length > 0 ? ['VERIFY: the /cloudapi/vcf/orgs/<id>/… paths and bodies of the 9.1 settings (load balancing, security delegation, external connections, shared subnets, networking defaults). They are not in the public API reference; apply-org-91.sh writes only to a path that answers and prints the portal route for the rest.'] : []),
            ],
          }),
        },
        notes: [
          'is_classic_tenant decides VM Apps (true) or All Apps (false), and forces replacement if changed. Choose once.',
          'Region quota arguments follow the vmware/vcfa documentation (vcfa_org_region_quota): supervisor_ids, zone_resource_allocations, region_vm_class_ids, region_storage_policy with storage_limit_mib.',
          '9.1 adds quota across several supervisors in a region, multiple external connections per organization, and default private VPC and transit gateway IP blocks. None of these exist on 9.0.',
          'Import an organization made in the portal with terraform import vcfa_org.<name> <org-name> before managing it here, or Terraform will try to make a second one.',
        ],
        findings,
      };
    },
  }),

  // -------------------------------------------------------------------------
  automationBlueprint({
    id: 'vcfa91_region_zone',
    platform: PLATFORM,
    label: 'Regions, zones and supervisors for All Apps',
    group: 'VCF Automation 9.1 — provider',
    description:
      'A region — an NSX Manager, one or more supervisors and the storage policies offered — as Terraform, and an inventory of what the region actually offers: zones and whether each has a network stack, VM classes, storage policies and classes, and namespace classes. The inventory is what an organization quota and a namespace class have to be written against.',
    inputs: [
      { id: 'create_region', label: 'Create the region', control: 'toggle', default: true, hint: 'Off: inventory only' },
      { id: 'region_name', label: 'Region name', control: 'text', default: 'region1' },
      { id: 'nsx_manager', label: 'NSX Manager', control: 'text', default: 'nsx-wld01', showWhen: { input: 'create_region', equals: ['true'] } },
      { id: 'vcenter', label: 'vCenter', control: 'text', default: 'vcenter-wld01', showWhen: { input: 'create_region', equals: ['true'] } },
      { id: 'supervisors', label: 'Supervisors', control: 'text', default: 'supervisor-wld01', showWhen: { input: 'create_region', equals: ['true'] } },
      { id: 'storage_policies', label: 'Storage policies', control: 'text', default: 'vSAN Default Storage Policy', hint: 'Comma separated, as named in vCenter', showWhen: { input: 'create_region', equals: ['true'] } },
      { id: 'expected_vm_classes', label: 'VM classes you expect to offer', control: 'text', default: 'best-effort-small, best-effort-medium, best-effort-large, guaranteed-medium', hint: 'The inventory flags any missing' },
    ],
    automation: (values                 , name        )             => {
      const create = bool(values, 'create_region', true);
      const region = str(values, 'region_name', 'region1');
      const nsx = str(values, 'nsx_manager', 'nsx-wld01');
      const vcenter = str(values, 'vcenter', 'vcenter-wld01');
      const supervisors = listOf(str(values, 'supervisors', 'supervisor-wld01'));
      const policies = listOf(str(values, 'storage_policies', 'vSAN Default Storage Policy'));
      const expected = listOf(str(values, 'expected_vm_classes', ''));
      const tf = label(region, 'region').replace(/-/g, '_');
      void name;

      const findings            = [];
      if (!LABEL.test(region)) findings.push(error('vcfa91.region.name', `"${region}" is not an RFC 1123 label, which a region name must be.`, { source: SRC }));
      if (create && supervisors.length === 0) findings.push(error('vcfa91.region.no-supervisor', 'A region needs at least one supervisor.', { source: SRC }));
      if (create && policies.length === 0) findings.push(error('vcfa91.region.no-storage', 'A region needs at least one storage policy.', { source: SRC }));
      findings.push(
        info('vcfa91.region.network-stack', 'VCF Automation 9.1.1 known issue: region creation can fail with "zones of the specified supervisors don’t have a network stack configured" on VLAN-backed stacks.', {
          remediation: 'Refresh the vCenter connection in the provider portal, or call its refresh API, and create the region again. The inventory lists zones so you can see which one it means.',
          source: 'VCF Automation 9.1.1 release notes',
        }),
      );

      const regionTf = [
        `# Region ${region}. Provider work: VCFA_ORG=System with a provider API token.`,
        '',
        `data "vcfa_vcenter" "vc" {`,
        `  name = ${q(vcenter)}`,
        '}',
        '',
        'data "vcfa_nsx_manager" "nsx" {',
        `  name = ${q(nsx)}`,
        '}',
        '',
        ...supervisors.flatMap((s, i) => [`data "vcfa_supervisor" "sv${i}" {`, `  name       = ${q(s)}`, '  vcenter_id = data.vcfa_vcenter.vc.id', '}', '']),
        `resource "vcfa_region" "${tf}" {`,
        `  name                 = ${q(region)}`,
        '  description          = "Managed by Terraform"',
        '  nsx_manager_id       = data.vcfa_nsx_manager.nsx.id',
        `  supervisor_ids       = [${supervisors.map((_, i) => `data.vcfa_supervisor.sv${i}.id`).join(', ')}]`,
        `  storage_policy_names = [${policies.map(q).join(', ')}]`,
        '',
        '  lifecycle {',
        '    # Every organization quota in the region depends on it.',
        '    prevent_destroy = true',
        '  }',
        '}',
        '',
      ].join('\n');

      const inventory = restScript({
        purpose: `Inventory region ${region}: status, zones, supervisors, VM classes, storage policies and classes.`,
        scope: 'provider',
        act: false,
        checkVersion: true,
        body: [
          `REGION=${q(region)}`,
          `EXPECTED_CLASSES=(${expected.map(q).join(' ')})`,
          'PROBLEMS=0',
          '# VERIFY: the region family lives under /cloudapi/vcf/ (go-vcloud-director OpenApiPathVcf).',
          'R=$(probe "/cloudapi/vcf/regions?filter=name==${REGION}") || exit 2',
          "[[ \"$(jq '.values | length' <<<\"$R\")\" == 1 ]] || { echo \"Region ${REGION}: not found\"; exit 1; }",
          "RID=$(jq -r '.values[0].id' <<<\"$R\")",
          "STATUS=$(jq -r '.values[0].status // \"?\"' <<<\"$R\")",
          "jq -r '.values[0] | \"Region \\(.name) status=\\(.status // \"?\") cpu=\\(.cpuCapacityMHz // \"?\")MHz memory=\\(.memoryCapacityMiB // \"?\")MiB\"' <<<\"$R\"",
          '[[ "$STATUS" == READY ]] || PROBLEMS=$((PROBLEMS+1))',
          '',
          'echo; echo "Zones:"',
          'if Z=$(probe "/cloudapi/vcf/zones?filter=region.id==${RID}&pageSize=128"); then',
          "  jq -r '.values[]? | \"  \\(.name)  cpu=\\(.cpuLimitMHz // .totalCpuCapacityMHz // \"?\")  memory=\\(.memoryLimitMiB // .totalMemoryCapacityMiB // \"?\")\"' <<<\"$Z\"",
          "  [[ \"$(jq '.values | length' <<<\"$Z\")\" -gt 0 ]] || { echo '  none — the supervisors have no zones VCF Automation can use'; PROBLEMS=$((PROBLEMS+1)); }",
          'fi',
          '',
          'echo; echo "Supervisors:"',
          "probe \"/cloudapi/vcf/supervisors?filter=region.id==${RID}\" | jq -r '.values[]? | \"  \\(.name)  \\(.status // \"\")\"' || true",
          '',
          'echo; echo "VM classes:"',
          '# VM classes: /cloudapi/vcf/virtualMachineClasses (go-vcloud-director tm_region_vm_class.go).',
          'if C=$(probe "/cloudapi/vcf/virtualMachineClasses?filter=region.id==${RID}&pageSize=128"); then',
          "  jq -r '.values[]? | \"  \\(.name)  cpu=\\(.cpuCount // \"?\") memory=\\(.memoryMiB // \"?\")MiB reserved=\\(.reserved // \"?\")\"' <<<\"$C\"",
          '  for c in "${EXPECTED_CLASSES[@]}"; do',
          "    jq -e --arg c \"$c\" '[.values[]?.name] | index($c)' <<<\"$C\" >/dev/null || { echo \"  MISSING: $c\"; PROBLEMS=$((PROBLEMS+1)); }",
          '  done',
          'fi',
          '',
          'echo; echo "Storage policies:"',
          "probe \"/cloudapi/vcf/regionStoragePolicies?filter=region.id==${RID}\" | jq -r '.values[]? | \"  \\(.name)\"' || true",
          'echo; echo "Storage classes:"',
          "probe \"/cloudapi/vcf/storageClasses?filter=region.id==${RID}\" | jq -r '.values[]? | \"  \\(.name)\"' || true",
          '',
          'exit $(( PROBLEMS > 0 ? 1 : 0 ))',
        ],
      });

      const nsClasses = kubeReadScript('List namespace classes and what each allows (organization context).', [
        '# VERIFY the resource name: kubectl api-resources | grep -i namespaceclass',
        'if kubectl get supervisornamespaceclasses >/dev/null 2>&1; then',
        '  kubectl get supervisornamespaceclasses -o wide',
        '  echo',
        '  kubectl get supervisornamespaceclassconfigs -o yaml 2>/dev/null | grep -E "^  name:|limit:|name:" || true',
        'else',
        '  echo "No supervisornamespaceclasses resource in this context — log in to an All Apps organization (vcf context use <org-context>)."',
        '  PROBLEMS=1',
        'fi',
      ]);

      const pkg = toPackage({
        packageName: packageNameOf('vcfa91', 'region', region),
        description: `Inventories region ${region} of VCF Automation 9.1 from the provider side: status, zones, supervisors, VM classes, storage policies and classes. Reads only.`,
        categoryPath: `${AREA}/Regions/${region}`,
        workflow: {
          name: `Inventory region ${label(region, 'region')}`,
          description: `Reads region ${region} through /cloudapi/vcf: its status, zones, supervisors, VM classes (against the ${expected.length} expected), storage policies and storage classes. Reads only; fails the run when something needs attention, so a schedule alerts.${create ? ' The region itself is created with the Terraform in region.tf.' : ''}`,
          inputs: [],
          outputs: [
            { name: 'inventory', type: 'string', description: 'What the region offers, JSON' },
            { name: 'problemCount', type: 'number', description: 'Things that need attention' },
            { name: 'summary', type: 'string', description: 'The audit record, JSON' },
          ],
          script: regionWorkflow(),
        },
        config: {
          name: 'Settings',
          description: 'Settings of the region inventory workflow. Fill vcfaApiToken (a provider API token; a read-only provider role is enough) after import.',
          attributes: [VCFA_HOST_ATTR, TOKEN_ATTR('a provider account'), API_VERSION_ATTR, WEBHOOK_ATTR],
        },
        resources: [{ name: 'region.json', content: json({ region, expectedVmClasses: expected }) }],
      });

      return {
        platform: PLATFORM,
        title: create ? `Region ${region} and its inventory` : `Inventory of region ${region}`,
        effect: create ? 'reversible' : 'read',
        trigger: { kind: 'manual', detail: create ? 'A provider administrator adding a region runs plan.sh; the inventory runs any time.' : 'Run by hand, or weekly, before writing quotas and namespace classes.' },
        scope: {
          what: create ? `Region ${region}: ${supervisors.length} supervisor(s), NSX Manager ${nsx}, ${policies.length} storage polic${policies.length === 1 ? 'y' : 'ies'}.` : `Region ${region}, read only.`,
          decidedBy: [
            'The supervisors named, and every zone they have.',
            'The storage policies named, which become the storage classes organizations can be granted.',
            'The NSX Manager, which provides VPC networking for the region.',
          ],
          ifWrong: 'A supervisor in the wrong region makes its capacity grantable to organizations that were never meant to land there.',
        },
        guardrails: create
          ? [
              { rule: 'Apply only a saved, read plan', because: 'The plan shows which supervisors join the region before they do.' },
              { rule: 'prevent_destroy on the region', because: 'Every organization quota in the region depends on it.' },
            ]
          : [],
        dryRun: create ? ['scripts/plan.sh --dry-run: plans and stops.', 'The Inventory region workflow, scripts/inventory.sh and scripts/namespace-classes.sh only read.'] : ['Everything here reads only.'],
        undo: create ? ['Remove the region from main.tf and apply after every organization quota in it is removed. prevent_destroy has to be taken off first.'] : ['Nothing to undo.'],
        told: ['Provider events in VCF Automation.', 'The workflow log and its inventory output, and the webhook when set; a run with problems fails — schedule it weekly and it becomes the record.'],
        requires: ['VCF Automation 9.1 with the vCenter and NSX Manager connected in the provider portal.', 'Supervisors enabled with VPC networking (or 9.1.1 VLAN-backed VPC).'],
        files: {
          ...pkg.files,
          ...(create ? { 'versions.tf': VERSIONS_TF, 'region.tf': regionTf, 'scripts/plan.sh': tfScript(`Create region ${region}.`, 'remove it from region.tf and apply, after its quotas are gone.') } : {}),
          'scripts/inventory.sh': inventory,
          'scripts/namespace-classes.sh': nsClasses,
          'IMPORT.md': importMd({
            subject: `Region ${region}: ${create ? 'created through the vmware/vcfa Terraform provider, then inventoried by an Orchestrator workflow' : 'inventoried by an Orchestrator workflow'} (or the script).`,
            orgs: PROVIDER,
            steps: [
              ...(create ? [tfStep('Create the region', 'Provider work: VCFA_ORG=System. Creating a region names an NSX Manager, supervisors and storage policies; the vmware/vcfa provider is the documented client for it, so it is not repeated in the workflow.')] : []),
              ...pkg.importSteps,
              checkStep('inventory.sh', 'the region, its zones, supervisors, VM classes and storage.'),
              manualStep('Namespace classes', ['`./scripts/namespace-classes.sh` lists them from an organization kubectl context. To create one, see "A Supervisor namespace, requested from All Apps".']),
            ],
            auth: ['terraform', 'vcfa91', 'kube'],
            verify: [
              'The /cloudapi/vcf paths follow the go-vcloud-director v3 SDK (OpenApiPathVcf with regions/, zones/, supervisors/, virtualMachineClasses/, regionStoragePolicies/, storageClasses/). VM classes are at virtualMachineClasses — earlier versions of this kit read regionVirtualMachineClasses. The filter field region.id is VERIFY; a path that answers 404 is reported as a problem, not passed.',
              'The response fields status, cpuCapacityMHz and memoryCapacityMiB are the SDK\'s Region type.',
            ],
          }),
        },
        notes: [
          'Region arguments follow vcfa_region: name (RFC 1123), nsx_manager_id, supervisor_ids, storage_policy_names.',
          'The /cloudapi/vcf/... inventory paths are inferred from the Go SDK the Terraform provider uses. Each is called through probe, which prints the HTTP status instead of failing silently when a path differs on your release.',
          'VM classes are defined on the supervisor in vCenter; the region exposes them and a quota grants them. A class missing from the inventory has to be made in vCenter first. 9.1.1 known issue: in mixed tenancy mode new VM classes may not show in the provider UI.',
          'Namespace classes are an organization object (the existing "A Supervisor namespace, requested from All Apps" blueprint writes one). Read them from an organization context.',
        ],
        findings,
      };
    },
  }),

  // -------------------------------------------------------------------------
  automationBlueprint({
    id: 'vcfa91_vpc',
    platform: PLATFORM,
    label: 'VPC subnets for an All Apps namespace, and the IP block behind them',
    group: 'VCF Automation 9.1 — networking',
    description:
      'NSX VPC networking as an All Apps organization consumes it: Public, Private and Private-TGW subnets in a namespace’s VPC as NSX operator Subnet objects, a discovery script showing the VPC, transit gateway reachability and existing subnets, and optionally the provider’s external IP block that Public subnets are carved from. Covers the 9.1.1 VLAN-backed VPC, where Private subnets are not supported.',
    inputs: [
      { id: 'namespace', label: 'Supervisor namespace', control: 'text', default: 'team-a-dev-x7k2p', hint: 'The generated name, with its suffix' },
      { id: 'vpc_name', label: 'VPC', control: 'text', default: 'region1-default-vpc', hint: 'The region default VPC is <region>-default-vpc' },
      {
        id: 'connectivity',
        label: 'VPC connectivity',
        control: 'select',
        options: [
          { value: 'centralized', label: 'Centralized — transit gateway on edges, NAT and Private subnets' },
          { value: 'distributed-vlan', label: 'VLAN-backed (9.1.1) — no overlay, no Private subnets' },
        ],
        default: 'centralized',
      },
      { id: 'subnets', label: 'Subnets', control: 'textarea', default: 'web: Public: 16\napp: Private: 64\ndb: PrivateTGW: 32', hint: 'name: Public|Private|PrivateTGW: number of addresses (a power of two), one per line' },
      { id: 'dhcp', label: 'DHCP on the subnets', control: 'toggle', default: true },
      { id: 'include_ip_block', label: 'Also write the provider’s external IP block', control: 'toggle', default: false },
      { id: 'vlan_connection', label: 'Also create the distributed VLAN connection (provider, NSX)', control: 'toggle', default: false, showWhen: { input: 'connectivity', equals: ['distributed-vlan'] } },
      { id: 'vlan_name', label: 'VLAN connection name', control: 'text', default: 'vlan-120-external', showWhen: { input: 'vlan_connection', equals: ['true'] } },
      { id: 'vlan_ids', label: 'VLAN ids', control: 'text', default: '120', hint: 'Comma separated, or a range 120-129', showWhen: { input: 'vlan_connection', equals: ['true'] } },
      { id: 'vlan_gateways', label: 'Gateway addresses (CIDR)', control: 'text', default: '198.51.100.1/24', hint: 'The physical router on the VLAN, comma separated', showWhen: { input: 'vlan_connection', equals: ['true'] } },
      { id: 'ip_block_name', label: 'External IP block name', control: 'text', default: 'region1-external', showWhen: { input: 'include_ip_block', equals: ['true'] } },
      { id: 'ip_block_cidr', label: 'External IP block CIDRs', control: 'text', default: '203.0.113.0/24', hint: 'Comma separated: 9.1 takes several CIDRs in one block', showWhen: { input: 'include_ip_block', equals: ['true'] } },
      { id: 'ip_block_ranges', label: 'Only these ranges may be allocated', control: 'text', default: '', placeholder: '203.0.113.64-203.0.113.127', hint: 'start-end, comma separated; empty: the whole CIDRs', showWhen: { input: 'include_ip_block', equals: ['true'] } },
      { id: 'ip_block_reserved', label: 'Keep these out', control: 'text', default: '203.0.113.1-203.0.113.9', hint: 'Addresses or start-end, comma separated: gateways, DNS, anything already in use', showWhen: { input: 'include_ip_block', equals: ['true'] } },
      {
        id: 'ipam',
        label: 'Addresses managed by',
        control: 'select',
        options: [
          { value: 'nsx', label: 'NSX (VCF Automation allocates)' },
          { value: 'infoblox', label: 'Infoblox (9.1 integration)' },
        ],
        default: 'nsx',
        showWhen: { input: 'include_ip_block', equals: ['true'] },
      },
      { id: 'infoblox_view', label: 'Infoblox network view', control: 'text', default: 'default', showWhen: { input: 'ipam', equals: ['infoblox'] } },
      { id: 'region', label: 'Region', control: 'text', default: 'region1', showWhen: { input: 'include_ip_block', equals: ['true'] } },
      { id: 'max_subnet_size', label: 'Largest prefix an organization may take', control: 'number', default: 26, min: 8, max: 32, showWhen: { input: 'include_ip_block', equals: ['true'] } },
    ],
    automation: (values                 , name        )             => {
      const namespace = str(values, 'namespace', 'team-a-dev');
      const vpc = str(values, 'vpc_name', 'region1-default-vpc');
      const vlan = str(values, 'connectivity', 'centralized') === 'distributed-vlan';
      const dhcp = bool(values, 'dhcp', true);
      const withBlock = bool(values, 'include_ip_block', false);
      const blockName = str(values, 'ip_block_name', 'region1-external');
      const blockCidrs = listOf(str(values, 'ip_block_cidr', '203.0.113.0/24'));
      const blockRanges = withBlock ? listOf(str(values, 'ip_block_ranges', '')) : [];
      const blockReserved = withBlock ? listOf(str(values, 'ip_block_reserved', '')) : [];
      const infoblox = withBlock && str(values, 'ipam', 'nsx') === 'infoblox';
      const infobloxView = str(values, 'infoblox_view', 'default');
      const region = str(values, 'region', 'region1');
      const maxSize = num(values, 'max_subnet_size', 26);
      const vlanConn = vlan && bool(values, 'vlan_connection', false);
      const vlanName = label(str(values, 'vlan_name', 'vlan'), 'vlan');
      const vlanIds = listOf(str(values, 'vlan_ids', ''));
      const vlanGateways = listOf(str(values, 'vlan_gateways', ''));
      void name;

      const findings            = [];
      const subnets = str(values, 'subnets', '')
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .map((line) => {
          const [n = '', mode = '', size = ''] = line.split(':').map((p) => p.trim());
          return { name: n.toLowerCase(), mode, size: Number(size), line };
        });
      const MODES = ['Public', 'Private', 'PrivateTGW'];
      for (const s of subnets) {
        if (!LABEL.test(s.name)) findings.push(error('vcfa91.vpc.name', `Subnet "${s.name}" is not a valid Kubernetes name.`, { path: s.line, source: SRC }));
        if (!MODES.includes(s.mode)) findings.push(error('vcfa91.vpc.mode', `"${s.mode}" is not an access mode. Use Public, Private or PrivateTGW.`, { path: s.line, source: SRC }));
        if (!Number.isInteger(s.size) || s.size < 4 || (s.size & (s.size - 1)) !== 0) {
          findings.push(error('vcfa91.vpc.size', `Subnet ${s.name}: ${s.size} addresses is not a power of two. NSX allocates subnets as CIDR blocks.`, { remediation: '16, 32, 64, 128, 256…', source: SRC }));
        }
        if (vlan && s.mode === 'Private') {
          findings.push(error('vcfa91.vpc.vlan-private', `Subnet ${s.name} is Private, which a VLAN-backed VPC does not support.`, { remediation: 'On 9.1.1 VLAN-backed VPCs the IP scheme comes from the physical VLAN CIDRs; use Public or PrivateTGW, or a centralized VPC.', source: 'VCF Automation 9.1.1 release notes' }));
        }
      }
      if (subnets.length === 0) findings.push(error('vcfa91.vpc.none', 'No subnets are listed.', { source: SRC }));
      const publicAddresses = subnets.filter((s) => s.mode === 'Public').reduce((sum, s) => sum + (Number.isFinite(s.size) ? s.size : 0), 0);
      if (publicAddresses > 0) {
        findings.push(info('vcfa91.vpc.public', `${publicAddresses} Public addresses come from the provider’s external IP block and are routed to the Tier-0.`, { remediation: 'Public is for what has to be reached from outside. Most tiers are Private behind NAT, or PrivateTGW when other VPCs on the same transit gateway need them.', source: SRC }));
      }
      // VPC subnets from the NSX operator are sized with ipv4SubnetSize: there is
      // no IPv6 in this path, so an IPv6 block would be one nothing can use.
      for (const blockCidr of withBlock ? blockCidrs : []) {
        if (familyOf(blockCidr) === 6) {
          findings.push(
            error('vcfa91.vpc.ipv6', `External IP blocks for NSX VPCs on VCF Automation 9.1 do not support IPv6 (${blockCidr}): VPC subnets are carved as IPv4 (ipv4SubnetSize).`, {
              remediation: 'Give an IPv4 block. VERIFY: IPv6 for VPCs in the NSX release behind your 9.1.x before planning around it.',
              source: SRC,
            }),
          );
        } else if (familyOf(blockCidr) !== 4 || !blockCidr.includes('/')) {
          findings.push(error('vcfa91.vpc.cidr', `"${blockCidr}" is not an IPv4 CIDR.`, { source: SRC }));
        }
      }
      if (withBlock && blockCidrs.length === 0) findings.push(error('vcfa91.vpc.cidr', 'The external IP block has no CIDR.', { source: SRC }));
      const v4 = (t        ) => familyOf(t) === 4 && !t.includes('/');
      const rangeOf = (t        ) => {
        const [a = '', b] = t.split('-').map((x) => x.trim());
        return b === undefined ? { a, b: a } : { a, b };
      };
      for (const r of [...blockRanges, ...blockReserved]) {
        const { a, b } = rangeOf(r);
        if (!v4(a) || !v4(b)) findings.push(error('vcfa91.vpc.range', `"${r}" is not an IPv4 address or start-end range.`, { source: SRC }));
      }
      if (infoblox) findings.push(info('vcfa91.vpc.infoblox', `Allocations from ${blockName} come from Infoblox (network view ${infobloxView}): the Infoblox integration is set in the provider portal first.`, { remediation: 'IMPORT.md has the steps. VERIFY: whether the 9.1 Infoblox integration has an API; the steps are the portal route.', source: 'VCF Automation 9.1 what’s new' }));
      if (vlanConn) {
        for (const id of vlanIds) if (!/^\d{1,4}(-\d{1,4})?$/.test(id) || id.split('-').some((n) => Number(n) < 1 || Number(n) > 4094)) findings.push(error('vcfa91.vpc.vlan-id', `"${id}" is not a VLAN id (1–4094) or range.`, { source: SRC }));
        for (const g of vlanGateways) if (familyOf(g) !== 4 || !g.includes('/')) findings.push(error('vcfa91.vpc.vlan-gateway', `"${g}" is not an IPv4 gateway address with its prefix (198.51.100.1/24).`, { source: SRC }));
        if (vlanIds.length === 0 || vlanGateways.length === 0) findings.push(error('vcfa91.vpc.vlan-missing', 'A distributed VLAN connection needs VLAN ids and gateway addresses.', { source: SRC }));
      }

      const subnetObjects               = subnets.map((sn) => ({
        plural: 'subnets',
        object: {
          apiVersion: 'crd.nsx.vmware.com/v1alpha1',
          kind: 'Subnet',
          metadata: { name: sn.name, namespace, labels: { 'vcf.automation/managed': 'true' } },
          spec: { accessMode: sn.mode, ipv4SubnetSize: Number.isFinite(sn.size) ? sn.size : 16, subnetDHCPConfig: { mode: dhcp ? 'DHCPServer' : 'DHCPDeactivated' } },
        },
      }));
      const yaml = k8sYaml(subnetObjects.map((o) => ({ comment: ['VERIFY apiVersion and field names: kubectl explain subnet.spec (crd.nsx.vmware.com)'], object: o.object })));
      const pkg = toPackage({
        packageName: packageNameOf('vcfa91', 'vpc', namespace),
        description: `Creates ${subnets.length} VPC subnet(s) in the All Apps namespace ${namespace}.`,
        categoryPath: `${AREA}/VPC subnets/${namespace}`,
        workflow: {
          name: `Create VPC subnets in ${label(namespace, 'namespace')}`,
          description: `Creates the NSX operator Subnet objects ${subnets.map((sn) => sn.name).join(', ')} in namespace ${namespace}, through the namespace's Kubernetes API: each that does not exist, never changing one that does. With the dryRun input set to true it validates each on the server (dryRun=All) and changes nothing.`,
          inputs: [DRY_RUN_INPUT],
          outputs: KUBE_OUTPUTS,
          script: kubeWorkflow({ resource: 'subnets.json', served: ['crd.nsx.vmware.com/v1alpha1'], label: '"subnet " + o.metadata.name + " (" + o.spec.accessMode + ", " + o.spec.ipv4SubnetSize + " addresses) in " + o.metadata.namespace' }),
        },
        config: kubeConfig('VPC subnets', '', Math.max(1, subnets.length)),
        resources: [{ name: 'subnets.json', content: json(subnetObjects) }],
      });

      const discover = kubeReadScript(`Show the VPC networking of namespace ${namespace}: API versions, VPC, subnets and subnet sets.`, [
        `NS=${q(namespace)}`,
        'echo "NSX operator resources on this endpoint:"',
        'kubectl api-resources --api-group=crd.nsx.vmware.com -o wide || { echo "crd.nsx.vmware.com is not served here"; PROBLEMS=1; }',
        'echo',
        'echo "Network info for ${NS} (which VPC it is attached to):"',
        'kubectl get networkinfos -n "$NS" -o yaml 2>/dev/null | grep -E "name:|vpc|cidr|Path" || echo "  (none visible — VERIFY: kubectl api-resources | grep -i networkinfo)"',
        'echo',
        'echo "Subnets and subnet sets:"',
        'kubectl get subnets,subnetsets -n "$NS" -o wide || PROBLEMS=1',
        `echo; echo "Expected VPC: ${vpc}"`,
      ]);

      const blockTf = [
        `# External IP block ${blockName} in region ${region}. Provider work.`,
        '# 9.1 renames IP spaces to external IP blocks; the vcfa provider still calls the resource vcfa_ip_space.',
        '',
        'data "vcfa_region" "region" {',
        `  name = ${q(region)}`,
        '}',
        '',
        `resource "vcfa_ip_space" "${label(blockName, 'block').replace(/-/g, '_')}" {`,
        `  name                          = ${q(blockName)}`,
        '  description                   = "Managed by Terraform"',
        '  region_id                     = data.vcfa_region.region.id',
        `  default_quota_max_subnet_size = ${maxSize}`,
        '  default_quota_max_cidr_count  = 4',
        '  default_quota_max_ip_count    = 16',
        '',
        ...blockCidrs.flatMap((cidr, i) => ['  cidr_blocks {', `    name = ${q(blockCidrs.length > 1 ? `${blockName}-${i + 1}` : blockName)}`, `    cidr = ${q(cidr)}`, '  }', '']),
        ...(infoblox ? [`  # Addresses come from Infoblox (network view ${infobloxView}) once the provider has the integration set; VERIFY whether vcfa_ip_space has an argument for it on your provider version.`, ''] : []),
        '  lifecycle {',
        '    prevent_destroy = true',
        '  }',
        '}',
        '',
      ].join('\n');

      // Include ranges and reserved addresses: on the NSX IP block behind the external IP block.
      const rangeBody = {
        range_list: blockRanges.map((r) => {
          const [a = '', b] = r.split('-').map((x) => x.trim());
          return { start: a, end: b ?? a };
        }),
        reserved_ips: blockReserved,
      };
      const rangesScript = nsxScript({
        purpose: `Add the include ranges and reserved addresses of ${blockName} to its NSX IP block (adds only; never removes).`,
        body: [
          `NAME=${q(blockName)}`,
          "ID=$(nsx_get '/infra/ip-blocks' | jq -r --arg n \"$NAME\" '[.results[]? | select(.display_name == $n) | .id][0] // empty')",
          '[[ -n "$ID" ]] || { echo "No NSX IP block named ${NAME} yet: apply ip-block.tf first (VERIFY: the display name VCF Automation gives it)." >&2; exit 1; }',
          'CUR=$(nsx_get "/infra/ip-blocks/${ID}")',
          "NEW=$(jq --slurpfile w nsx/ip-block-ranges.json '{range_list: ((.range_list // []) + $w[0].range_list | unique), reserved_ips: ((.reserved_ips // []) + $w[0].reserved_ips | unique)}' <<<\"$CUR\")",
          "if [[ \"$(jq -S '{range_list: (.range_list // []), reserved_ips: (.reserved_ips // [])}' <<<\"$CUR\")\" == \"$(jq -S . <<<\"$NEW\")\" ]]; then",
          '  echo "Already set: ranges and reserved addresses of ${NAME}"',
          'elif (( DRY_RUN )); then echo "DRY RUN: would PATCH /infra/ip-blocks/${ID}:"; echo "$NEW"',
          'else',
          '  curl -sS -f -K <(nsx_cfg) -X PATCH "${API}/infra/ip-blocks/${ID}" -H "Accept: application/json" -H "Content-Type: application/json" --data-binary "$NEW" >/dev/null',
          '  echo "Updated: ranges and reserved addresses of ${NAME}"',
          'fi',
        ],
        undo: 'PATCH the block with the range_list and reserved_ips it had (the script prints the new values; GET it first to keep the old).',
      });
      const vlanObjects              = vlanConn ? [{ label: `distributed VLAN connection ${vlanName}`, path: `/infra/distributed-vlan-connections/${vlanName}`, file: `nsx/vlan-connection-${vlanName}.json`, body: { display_name: vlanName, vlan_ids: vlanIds, gateway_addresses: vlanGateways } }] : [];
      const vlanScript = nsxScript({ purpose: `Create the distributed VLAN connection ${vlanName} for VLAN-backed VPCs.`, body: nsxEnsureLines(vlanObjects), undo: `DELETE /policy/api/v1/infra/distributed-vlan-connections/${vlanName} once no VPC or region uses it.` });

      return {
        platform: PLATFORM,
        title: `${subnets.length} VPC subnet(s) in namespace ${namespace}`,
        effect: 'reversible',
        trigger: { kind: 'manual', detail: 'A project member or organization administrator creates the subnets for an application, before the VMs that use them.' },
        scope: {
          what: `Subnets ${subnets.map((s) => s.name).join(', ')} in the VPC of namespace ${namespace}${withBlock ? `, and the external IP block ${blockName}` : ''}.`,
          decidedBy: [
            'The namespace in each object, and the kubectl context the script checks.',
            `The VPC the namespace is attached to (${vpc} unless the organization chose another).`,
            'The organization’s IP block quota, which bounds Public subnets.',
          ],
          ifWrong: 'A Public subnet exposes its VMs to whatever the Tier-0 advertises to; a wrong namespace puts the subnet in another team’s VPC.',
        },
        guardrails: [
          { rule: 'The script stops unless the current context is EXPECT_CONTEXT; the workflow sends only to the kubeServer of its configuration element', because: 'The context is the scope; a subnet created in the wrong organization is a routing change in someone else’s VPC.' },
          { rule: 'kubectl create, not apply', because: 'create refuses to change a subnet that already exists; resizing a live subnet renumbers what is on it.' },
          { rule: 'Server-side dry run with --dry-run (or the dryRun input) before the first real run', because: 'The NSX operator’s admission checks the access mode, size and quota before anything is allocated.' },
          ...(withBlock ? [{ rule: 'Apply only a saved, read plan for the IP block, with prevent_destroy', because: 'Destroying an external block withdraws addresses in use.' }] : []),
        ],
        dryRun: ['Run the workflow with the dryRun input set to true to preview: it sends each subnet with dryRun=All, so the NSX operator validates it, and creates nothing.', 'scripts/create-subnets.sh --dry-run runs the same server-side dry run.', 'scripts/discover.sh only reads.', ...(withBlock ? ['scripts/plan.sh --dry-run: plans and stops.'] : [])],
        undo: ['kubectl delete subnet <name> -n ' + namespace + ' — refused while VMs are attached. Public addresses go back to the organization’s quota.'],
        told: ['NSX Manager audit log for the subnet and its segment.', 'Kubernetes events on the Subnet object.', 'The workflow log (AUDIT lines), its summary output and the webhook when set.'],
        requires: ['An All Apps organization with regional networking set, and a namespace attached to a VPC.', 'kubectl and the VCF CLI, logged in to the organization and namespace.'],
        files: {
          ...pkg.files,
          'subnets.k8s.yaml': yaml,
          'scripts/create-subnets.sh': kubeScript(`Create the VPC subnets for ${namespace}.`, [], ['subnets.k8s.yaml'], `kubectl delete -f subnets.k8s.yaml (after the VMs on them are gone).`),
          'scripts/discover.sh': discover,
          ...(withBlock ? { 'versions.tf': VERSIONS_TF, 'ip-block.tf': blockTf, 'scripts/plan.sh': tfScript(`Create the external IP block ${blockName}.`, 'remove it from ip-block.tf and apply once nothing uses it.') } : {}),
          ...(withBlock && (blockRanges.length > 0 || blockReserved.length > 0) ? { 'nsx/ip-block-ranges.json': json(rangeBody), 'scripts/ip-block-ranges.sh': rangesScript } : {}),
          ...(vlanConn ? { [vlanObjects[0] .file]: json(vlanObjects[0] .body), 'scripts/vlan-connection.sh': vlanScript } : {}),
          'IMPORT.md': importMd({
            subject: `VPC subnets for the namespace ${namespace}: an Orchestrator workflow that creates them through the namespace's Kubernetes API, and the same objects as subnets.k8s.yaml for kubectl.`,
            orgs: ALL_APPS,
            steps: [
              ...(vlanConn ? [manualStep(`Distributed VLAN connection ${vlanName} (provider, NSX)`, ['`NSX_HOST=… NSX_USER=… NSX_PASSWORD_FILE=… ./scripts/vlan-connection.sh` creates it unless it exists (`--dry-run` to preview). Then select it for the region’s VLAN-backed VPC connectivity in the provider portal (9.1.1).'])] : []),
              ...(infoblox ? [manualStep('Infoblox (provider)', [`Provider portal → Infrastructure → IP Address Management → add the Infoblox integration (grid master, credentials from your vault) and map ${blockName} to network view ${infobloxView}, before the block is used. VERIFY the menu path on 9.1.`])] : []),
              ...(withBlock ? [tfStep(`External IP block ${blockName} (provider)`, `Provider work: VCFA_ORG=System. The external IP block is a provider object the vmware/vcfa provider manages (vcfa_ip_space), with ${blockCidrs.length} CIDR(s); it comes before the Public subnets drawn from it.`)] : []),
              ...(withBlock && (blockRanges.length > 0 || blockReserved.length > 0) ? [manualStep('Include ranges and reserved addresses (NSX)', ['`NSX_HOST=… NSX_USER=… NSX_PASSWORD_FILE=… ./scripts/ip-block-ranges.sh` adds nsx/ip-block-ranges.json to the NSX IP block behind the external block; it only adds, and `--dry-run` prints the result.'])] : []),
              manualStep('Look first', ['`./scripts/discover.sh` shows the namespace’s VPC, subnets and the API versions the server offers.']),
              ...pkg.importSteps,
              kubeStep('Or: the subnets with kubectl', 'scripts/create-subnets.sh', ['subnets.k8s.yaml']),
            ],
            auth: ['kube', 'vcfa91', ...(withBlock ? (['terraform']         ) : [])],
            verify: [
              'The subnet apiVersion (crd.nsx.vmware.com/v1alpha1) and accessMode names: kubectl explain subnet.spec. The workflow stops before sending anything if the group is not served.',
              KUBE_VERIFY,
              ...(withBlock && (blockRanges.length > 0 || blockReserved.length > 0) ? ['VERIFY: NSX IpAddressBlock range_list ({start, end}) and reserved_ips (NSX 4.2 and later), and that the NSX block carries the external IP block’s name as its display_name.'] : []),
              ...(vlanConn ? ['VERIFY: /infra/distributed-vlan-connections with vlan_ids and gateway_addresses (NSX 9 VLAN-backed VPC connectivity).'] : []),
            ],
          }),
        },
        notes: [
          'Access modes: Public comes from the external IP block and is advertised to the Tier-0; Private is reachable only inside the VPC and leaves by SNAT; PrivateTGW is reachable from every VPC on the same transit gateway (Tom Fojta, VCF Automation 9.0 networking deep dive). Older releases called PrivateTGW "Project" — VERIFY with kubectl explain subnet.spec.accessMode.',
          '9.1 adds several transit gateways per organization with NAT, IPsec VPN and gateway firewall ("Transit gateway services" and "A vDefend firewall policy" on this page), organization-wide shared subnets, and shared VLAN extension subnets from the provider ("A tenant organization"). Subnets here attach to whatever the VPC is connected to.',
          'VMs join a subnet by name in spec.network.interfaces (kind Subnet or SubnetSet) — see "A VM Service virtual machine".',
          'The VPC itself — the region default <region>-default-vpc, or another — is chosen when the namespace is made. There is no separate VPC object to write here that could be confirmed on 9.1.',
          'IPv4 only: the NSX operator Subnet is sized with ipv4SubnetSize and the external IP block behind Public subnets is IPv4, so this writes no IPv6 and refuses an IPv6 block. VERIFY: IPv6 for VPCs in the NSX release behind your 9.1.x.',
        ],
        findings,
      };
    },
  }),

  // -------------------------------------------------------------------------
  automationBlueprint({
    id: 'vcfa91_content_library',
    platform: PLATFORM,
    label: 'Content libraries and VM images for All Apps',
    group: 'VCF Automation 9.1 — content',
    description:
      'A content library as VCF Automation 9.1 has them — provider, organization, or (new in 9.1) project-scoped — local, subscribed to a URL, or subscribed to the Canonical Ubuntu images; with its OVA, OVF or ISO items uploaded, and a check that lists every item’s VM image identifier (vmi-…), which is what a VM Service request names.',
    inputs: [
      { id: 'library_name', label: 'Library name', control: 'text', default: 'team-a-images' },
      {
        id: 'owner',
        label: 'Owned by',
        control: 'select',
        options: [
          { value: 'org', label: 'The organization — shared with its projects' },
          { value: 'project', label: 'Projects only (9.1 project content library)' },
          { value: 'provider', label: 'The provider — shared to organizations' },
        ],
        default: 'org',
      },
      { id: 'org_name', label: 'Organization', control: 'text', default: 'team-a', showWhen: { input: 'owner', notEquals: ['provider'] } },
      {
        id: 'subscription',
        label: 'Source',
        control: 'select',
        options: [
          { value: 'local', label: 'Local — items uploaded here' },
          { value: 'url', label: 'Subscribed to a published library URL' },
          { value: 'canonical', label: 'Subscribed to Canonical Ubuntu images (9.1)' },
        ],
        default: 'local',
      },
      { id: 'subscription_url', label: 'Subscription URL', control: 'text', default: '', placeholder: 'https://library.example.com/lib.json', showWhen: { input: 'subscription', equals: ['url', 'canonical'] } },
      { id: 'subscription_password', label: 'The published library needs a password', control: 'toggle', default: false, showWhen: { input: 'subscription', equals: ['url'] } },
      { id: 'storage_class', label: 'Storage class', control: 'text', default: 'vsan-default-storage-policy' },
      { id: 'region', label: 'Region', control: 'text', default: 'region1' },
      {
        id: 'permission',
        label: 'Projects get',
        control: 'select',
        options: [
          { value: 'READ_ONLY', label: 'Read only' },
          { value: 'READ_WRITE', label: 'Read and write' },
        ],
        default: 'READ_ONLY',
        showWhen: { input: 'owner', notEquals: ['provider'] },
      },
      { id: 'items', label: 'Items to upload', control: 'textarea', default: 'ubuntu-24.04-server: images/ubuntu-24.04-server-cloudimg-amd64.ova', hint: 'name: path, one per line; an OVF lists its .vmdk files after it, comma separated', showWhen: { input: 'subscription', equals: ['local'] } },
    ],
    automation: (values                 , name        )             => {
      const lib = str(values, 'library_name', 'images');
      const owner = str(values, 'owner', 'org');
      const org = owner === 'provider' ? 'System' : str(values, 'org_name', 'team-a');
      const sub = str(values, 'subscription', 'local');
      const url = str(values, 'subscription_url', '');
      const needsPassword = sub === 'url' && bool(values, 'subscription_password', false);
      const storageClass = str(values, 'storage_class', 'vsan-default-storage-policy');
      const region = str(values, 'region', 'region1');
      const permission = str(values, 'permission', 'READ_ONLY');
      const tf = label(lib, 'library').replace(/-/g, '_');
      void name;
      const items =
        sub === 'local'
          ? str(values, 'items', '')
              .split('\n')
              .map((l) => l.trim())
              .filter(Boolean)
              .map((l) => {
                const at = l.indexOf(':');
                const itemName = at < 0 ? l.split('/').pop() ?? l : l.slice(0, at).trim();
                const paths = listOf(at < 0 ? l : l.slice(at + 1));
                return { name: itemName, paths };
              })
          : [];

      const findings            = [];
      if (sub !== 'local' && !url) {
        findings.push(
          warning('vcfa91.cl.no-url', sub === 'canonical' ? 'No Canonical subscription URL is set.' : 'No subscription URL is set.', {
            remediation: sub === 'canonical' ? 'Copy the Canonical subscription URL shown when creating a subscribed library in the 9.1 portal; this file leaves it <REQUIRED>.' : 'Use the published library’s lib.json URL.',
            source: SRC,
          }),
        );
      }
      if (needsPassword) {
        findings.push(warning('vcfa91.cl.password-401', 'Subscribing to a password-protected library fails with HTTP 401 on VCF Automation 9.1.1 (known issue), both at creation and at sync.', { remediation: 'Publish the source without a password on a network only the Supervisors reach, or wait for the fix.', source: 'VCF Automation 9.1.1 release notes' }));
      }
      for (const it of items) {
        const first = it.paths[0] ?? '';
        if (/\.ovf$/i.test(first) && it.paths.length < 2) {
          findings.push(warning('vcfa91.cl.ovf-files', `Item ${it.name} is an OVF with no disk files listed.`, { remediation: 'List the .vmdk (and .mf) files after the .ovf, comma separated, or package it as an OVA.', source: SRC }));
        }
        if (first && !/\.(ova|ovf|iso)$/i.test(first)) {
          findings.push(warning('vcfa91.cl.type', `Item ${it.name}: ${first} is not an OVA, OVF or ISO.`, { source: SRC }));
        }
      }
      if (sub === 'canonical') {
        findings.push(info('vcfa91.cl.canonical-sbom', 'Early 9.1 builds rejected some Canonical Ubuntu images on an SBOM file (fixed in 9.1.0.0200).', { remediation: 'Patch to 9.1.0.0200 or later before subscribing.', source: 'VCF Automation 9.1.0.0200 release notes' }));
      }

      const tfLines = [
        `# Content library ${lib} (${owner === 'provider' ? 'provider' : owner === 'project' ? `project-scoped, organization ${org}` : `organization ${org}`}).`,
        `# Run with VCFA_ORG=${org} and a token for it.`,
        '',
        'data "vcfa_region" "region" {',
        `  name = ${q(region)}`,
        '}',
        '',
        '# VERIFY the data source arguments: terraform providers schema -json | jq \'.provider_schemas[].data_source_schemas.vcfa_storage_class\'',
        'data "vcfa_storage_class" "sc" {',
        '  region_id = data.vcfa_region.region.id',
        `  name      = ${q(storageClass)}`,
        '}',
        '',
        ...(owner !== 'provider' ? ['data "vcfa_org" "org" {', `  name = ${q(org)}`, '}', ''] : ['data "vcfa_org" "system" {', '  name = "System"', '}', '']),
        ...(needsPassword ? ['variable "subscription_password" {', '  description = "From TF_VAR_subscription_password — never written to a file"', '  type        = string', '  sensitive   = true', '}', ''] : []),
        `resource "vcfa_content_library" "${tf}" {`,
        `  name              = ${q(lib)}`,
        '  description       = "Managed by Terraform"',
        `  org_id            = ${owner === 'provider' ? 'data.vcfa_org.system.id' : 'data.vcfa_org.org.id'}`,
        '  storage_class_ids = [data.vcfa_storage_class.sc.id]',
        ...(owner !== 'provider' ? ['  auto_attach       = true', `  is_project_scoped = ${owner === 'project' ? 'true' : 'false'}`, `  all_projects_permission = ${q(permission)}`] : []),
        ...(sub !== 'local'
          ? [
              '',
              '  subscription_config {',
              `    subscription_url = ${q(url || '<REQUIRED — the published library URL>')}`,
              ...(needsPassword ? ['    password         = var.subscription_password'] : []),
              '  }',
            ]
          : []),
        '}',
        '',
        ...items.flatMap((it, i) => [
          `resource "vcfa_content_library_item" "item${i}" {`,
          `  name               = ${q(it.name)}`,
          '  description        = "Managed by Terraform"',
          `  content_library_id = vcfa_content_library.${tf}.id`,
          `  file_paths         = [${it.paths.map(q).join(', ')}]`,
          '  upload_piece_size  = 10',
          '}',
          '',
        ]),
        'output "image_identifiers" {',
        '  description = "The vmi-… names VM Service requests use"',
        `  value       = { ${items.map((it, i) => `${q(it.name)} = vcfa_content_library_item.item${i}.image_identifier`).join(', ')} }`,
        '}',
        '',
      ].join('\n');

      const check = restScript({
        purpose: `Check content library ${lib} is READY and list its items with their VM image identifiers.`,
        scope: owner === 'provider' ? 'provider' : 'tenant',
        act: false,
        body: [
          `LIB=${q(lib)}`,
          '# VERIFY: /cloudapi/vcf/contentLibraries (go-vcloud-director OpenApiPathVcf + contentLibraries/).',
          'L=$(probe "/cloudapi/vcf/contentLibraries?filter=name==${LIB}") || exit 2',
          "[[ \"$(jq '.values | length' <<<\"$L\")\" -ge 1 ]] || { echo \"Library ${LIB}: not found\"; exit 1; }",
          "LID=$(jq -r '.values[0].id' <<<\"$L\"); STATUS=$(jq -r '.values[0].status // \"?\"' <<<\"$L\")",
          "jq -r '.values[0] | \"Library \\(.name): status=\\(.status // \"?\") type=\\(.libraryType // \"?\") subscribed=\\(.isSubscribed // \"?\")\"' <<<\"$L\"",
          'PROBLEMS=0',
          '[[ "$STATUS" == READY ]] || PROBLEMS=1',
          'if I=$(probe "/cloudapi/vcf/contentLibraryItems?filter=contentLibrary.id==${LID}&pageSize=128"); then',
          "  jq -r '.values[]? | \"  \\(.name)\\t\\(.itemType // \"?\")\\t\\(.imageIdentifier // \"-\")\\t\\(.status // \"?\")\"' <<<\"$I\"",
          "  BAD=$(jq '[.values[]? | select((.status // \"READY\") != \"READY\")] | length' <<<\"$I\")",
          '  (( BAD == 0 )) || { echo "  ${BAD} item(s) not READY"; PROBLEMS=1; }',
          'fi',
          'exit $PROBLEMS',
        ],
      });

      const pkg = toPackage({
        packageName: packageNameOf('vcfa91', 'library', lib),
        description: `Checks the VCF Automation 9.1 content library ${lib} and lists its items with their VM image identifiers. Reads only.`,
        categoryPath: `${AREA}/Content libraries/${lib}`,
        workflow: {
          name: `Check content library ${label(lib, 'library')}`,
          description: `Reads the content library ${lib} and its items through /cloudapi/vcf: fails the run unless the library and every item are READY, and lists each item's VM image identifier (vmi-…), which is what a VM Service request names. Reads only; the library and its uploads are created with the Terraform in content-library.tf.`,
          inputs: [],
          outputs: [
            { name: 'itemReport', type: 'string', description: 'CSV: name, type, imageIdentifier, status' },
            { name: 'problemCount', type: 'number', description: 'Things that are not READY or not found' },
            { name: 'summary', type: 'string', description: 'The audit record, JSON' },
          ],
          script: libraryWorkflow(),
        },
        config: {
          name: 'Settings',
          description: 'Settings of the content library check. Fill vcfaApiToken after import.',
          attributes: [VCFA_HOST_ATTR, ORG_ATTR(owner === 'provider' ? 'provider' : org), TOKEN_ATTR(owner === 'provider' ? 'a provider account' : `an account in ${org}`), API_VERSION_ATTR, WEBHOOK_ATTR],
        },
        resources: [{ name: 'library.json', content: json({ name: lib }) }],
      });

      return {
        platform: PLATFORM,
        title: `Content library ${lib}`,
        effect: 'reversible',
        trigger: { kind: 'manual', detail: 'An organization or provider administrator publishing images, and again whenever an image is replaced.', worstCase: sub !== 'local' ? 'a sync of every item on each subscription refresh — plan the storage for the whole source library' : undefined },
        scope: {
          what: `Library ${lib}${items.length ? ` and ${items.length} item(s)` : ''} on storage class ${storageClass} in region ${region}.`,
          decidedBy: [
            owner === 'provider' ? 'The provider, who shares it with organizations.' : owner === 'project' ? `Organization ${org}, scoped to the projects given permission (9.1).` : `Organization ${org}; auto_attach makes it visible in every namespace.`,
            sub !== 'local' ? 'The source library: whatever it publishes is synced here.' : 'The items listed.',
          ],
          ifWrong: 'An image in the wrong library is either invisible to the teams that need it or offered to teams that should not boot it; a subscription to a large source fills the storage class.',
        },
        guardrails: [
          { rule: 'Apply only a saved, read plan', because: 'The plan lists every upload and subscription before gigabytes move.' },
          ...(needsPassword ? [{ rule: 'The subscription password comes from TF_VAR_subscription_password, marked sensitive', because: 'It never lands in a .tf file or the plan output.' }] : []),
          { rule: 'check-library.sh fails unless the library and every item are READY', because: 'A PARTIALLY_READY library still appears in the picker and fails at VM creation.' },
        ],
        dryRun: ['scripts/plan.sh --dry-run: plans and stops.', 'The Check content library workflow and scripts/check-library.sh read only.'],
        undo: ['Remove the items or library from content-library.tf and apply. VMs already deployed from an image keep running; new requests naming its vmi fail.'],
        told: ['VCF Automation events, and vCenter content library tasks, which VCF Operations collects.', 'The Check content library workflow log and its itemReport output, and the webhook when set; a run fails unless everything is READY.'],
        requires: ['VCF Automation 9.1 (project content libraries and Canonical subscriptions are 9.1).', 'A storage class granted to the organization in the region.', 'Terraform 1.5+ and the image files on the host that runs plan.sh.'],
        files: {
          ...pkg.files,
          'versions.tf': VERSIONS_TF,
          'content-library.tf': tfLines,
          'scripts/plan.sh': tfScript(`Create content library ${lib}.`, 'remove it from content-library.tf and apply.'),
          'scripts/check-library.sh': check,
          'IMPORT.md': importMd({
            subject: `The content library ${lib} and its images: created with the vmware/vcfa Terraform provider (which uploads the OVA/OVF/ISO files), then checked by an Orchestrator workflow.`,
            orgs: ALL_APPS,
            steps: [
              tfStep('Create the library', `Run with VCFA_ORG=${org}. The uploads stream the image files from the host plan.sh runs on, which an Orchestrator workflow cannot do; so creating the library stays with Terraform.`),
              ...pkg.importSteps,
              checkStep('check-library.sh', 'the library is READY, with the image identifiers VM Service will use.'),
            ],
            auth: ['terraform', 'vcfa91'],
            verify: [
              'Arguments follow vcfa_content_library and vcfa_content_library_item in the vmware/vcfa provider documentation.',
              'The check reads /cloudapi/vcf/contentLibraries (go-vcloud-director OpenApiPathVcf + contentLibraries/, fields name, status, libraryType, isSubscribed) and /cloudapi/vcf/contentLibraryItems; the item fields itemType, imageIdentifier and status and the filter contentLibrary.id are VERIFY.',
            ],
          }),
        },
        notes: [
          'Arguments follow vcfa_content_library (org_id, storage_class_ids, auto_attach, is_project_scoped, all_projects_permission, subscription_config) and vcfa_content_library_item (content_library_id, file_paths, upload_piece_size in MB; image_identifier is read-only).',
          'VM Service names an image by its identifier (vmi-…) or its display name; the identifier survives a rename. kubectl get vmi / clustervmi in the namespace lists what is visible.',
          'is_project_scoped cannot be changed after creation.',
        ],
        findings,
      };
    },
  }),

  // -------------------------------------------------------------------------
  automationBlueprint({
    id: 'vcfa91_vm_service',
    platform: PLATFORM,
    label: 'A VM Service virtual machine, with cloud-init',
    group: 'VCF Automation 9.1 — consumption',
    description:
      'A virtual machine the All Apps way: a VirtualMachine object (vmoperator.vmware.com) with class, image, storage class, a named VPC subnet and cloud-init from a Secret, an optional data disk as a PVC, and an optional VirtualMachineService load balancer (Avi, self-service in 9.1). The script checks the API version is served and the image is visible before it creates anything.',
    inputs: [
      { id: 'vm_name', label: 'VM name', control: 'text', default: 'web01' },
      { id: 'namespace', label: 'Namespace', control: 'text', default: 'team-a-dev-x7k2p' },
      {
        id: 'api_version',
        label: 'VM Operator API',
        control: 'select',
        options: [
          { value: 'v1alpha5', label: 'v1alpha5 — VCF 9.x examples' },
          { value: 'v1alpha4', label: 'v1alpha4' },
          { value: 'v1alpha3', label: 'v1alpha3 — 9.0 KB examples' },
        ],
        default: 'v1alpha5',
      },
      { id: 'vm_class', label: 'VM class', control: 'text', default: 'best-effort-small' },
      { id: 'image', label: 'Image', control: 'text', default: 'vmi-0123456789abcdef0', hint: 'kubectl get vmi -n <namespace>' },
      { id: 'storage_class', label: 'Storage class', control: 'text', default: 'vsan-default-storage-policy' },
      {
        id: 'network_kind',
        label: 'Network',
        control: 'select',
        options: [
          { value: 'default', label: 'The namespace default' },
          { value: 'Subnet', label: 'A named Subnet' },
          { value: 'SubnetSet', label: 'A named SubnetSet' },
        ],
        default: 'Subnet',
      },
      { id: 'network_name', label: 'Subnet or SubnetSet name', control: 'text', default: 'web', showWhen: { input: 'network_kind', notEquals: ['default'] } },
      { id: 'cloud_init', label: 'Bootstrap with cloud-init', control: 'toggle', default: true },
      { id: 'admin_user', label: 'Admin user', control: 'text', default: 'ops', showWhen: { input: 'cloud_init', equals: ['true'] } },
      { id: 'ssh_key', label: 'SSH public key', control: 'text', default: '', placeholder: 'ssh-ed25519 AAAA… ops@example.com', showWhen: { input: 'cloud_init', equals: ['true'] } },
      { id: 'data_disk_gib', label: 'Data disk (GiB)', control: 'number', default: 0, min: 0, max: 62000, hint: '0 means none' },
      { id: 'load_balancer', label: 'Expose with a load balancer', control: 'toggle', default: false },
      { id: 'lb_ports', label: 'Ports', control: 'text', default: '443', showWhen: { input: 'load_balancer', equals: ['true'] } },
    ],
    automation: (values                 , name        )             => {
      const vm = label(str(values, 'vm_name', 'vm01'), 'vm01');
      const ns = str(values, 'namespace', 'team-a-dev');
      const api = str(values, 'api_version', 'v1alpha5');
      const cls = str(values, 'vm_class', 'best-effort-small');
      const image = str(values, 'image', '');
      const sc = str(values, 'storage_class', 'vsan-default-storage-policy');
      const netKind = str(values, 'network_kind', 'Subnet');
      const netName = str(values, 'network_name', 'web');
      const ci = bool(values, 'cloud_init', true);
      const user = str(values, 'admin_user', 'ops');
      const key = str(values, 'ssh_key', '');
      const disk = num(values, 'data_disk_gib', 0);
      const lb = bool(values, 'load_balancer', false);
      const ports = listOf(str(values, 'lb_ports', '443')).map(Number).filter((p) => Number.isInteger(p) && p > 0 && p < 65536);
      void name;

      const findings            = [];
      if (!image) findings.push(error('vcfa91.vm.no-image', 'No image is named.', { remediation: 'kubectl get vmi -n <namespace> lists the images the namespace can see.', source: SRC }));
      if (ci && !key) findings.push(info('vcfa91.vm.no-key', 'cloud-init has no SSH key, so nobody can log in except through the console.', { remediation: 'Add a public key. Never a password: cloud-init user-data is readable by anyone who can read the Secret.', source: SRC }));
      if (key && !/^(ssh-(ed25519|rsa)|ecdsa-sha2-nistp\d+) [A-Za-z0-9+/=]+/.test(key)) findings.push(warning('vcfa91.vm.key', 'The SSH key does not look like an OpenSSH public key.', { source: SRC }));
      if (/^guaranteed-/.test(cls)) findings.push(info('vcfa91.vm.guaranteed', `${cls} reserves its CPU and memory whether the VM uses them or not.`, { remediation: 'Right for latency-sensitive production; expensive for development.', source: SRC }));
      if (lb && ports.length === 0) findings.push(error('vcfa91.vm.ports', 'A load balancer needs at least one valid port.', { source: SRC }));
      if (api === 'v1alpha3') findings.push(info('vcfa91.vm.api', 'v1alpha3 is the 9.0-era version. On 9.1 check kubectl api-versions | grep vmoperator for the newest served.', { source: SRC }));

      const secretName = `${vm}-cloud-init`;
      const cloudConfig = [
        '#cloud-config',
        'users:',
        `  - name: ${user}`,
        '    sudo: "ALL=(ALL) NOPASSWD:ALL"',
        '    shell: /bin/bash',
        ...(key ? ['    ssh_authorized_keys:', `      - ${key}`] : []),
        'ssh_pwauth: false',
        'package_update: true',
        ...(disk > 0 ? ['disk_setup:', '  /dev/sdb:', '    table_type: gpt', '    layout: true', 'fs_setup:', '  - device: /dev/sdb1', '    filesystem: xfs', '    label: data', 'mounts:', '  - [LABEL=data, /data, xfs, "defaults,nofail", "0", "2"]'] : []),
      ];

      const vmObjects                                             = [];
      if (ci) {
        vmObjects.push({
          comment: ['cloud-init user-data. A public key only; no password is ever set here.'],
          item: { plural: 'secrets', object: { apiVersion: 'v1', kind: 'Secret', metadata: { name: secretName, namespace: ns }, type: 'Opaque', stringData: { 'user-data': `${cloudConfig.join('\n')}\n` } } },
        });
      }
      if (disk > 0) {
        vmObjects.push({
          item: { plural: 'persistentvolumeclaims', object: { apiVersion: 'v1', kind: 'PersistentVolumeClaim', metadata: { name: `${vm}-data`, namespace: ns }, spec: { accessModes: ['ReadWriteOnce'], storageClassName: sc, resources: { requests: { storage: `${disk}Gi` } } } } },
        });
      }
      vmObjects.push({
        item: {
          plural: 'virtualmachines',
          object: {
            apiVersion: `vmoperator.vmware.com/${api}`,
            kind: 'VirtualMachine',
            metadata: { name: vm, namespace: ns, labels: { app: vm, 'vcf.automation/managed': 'true' } },
            spec: {
              className: cls,
              imageName: image || '<REQUIRED — vmi-… from kubectl get vmi>',
              storageClass: sc,
              powerState: 'PoweredOn',
              ...(netKind !== 'default' ? { network: { interfaces: [{ name: 'eth0', network: { name: netName, kind: netKind, apiVersion: 'crd.nsx.vmware.com/v1alpha1' } }] } } : {}),
              ...(ci ? { bootstrap: { cloudInit: { rawCloudConfig: { name: secretName, key: 'user-data' } } } } : {}),
              ...(disk > 0 ? { volumes: [{ name: 'data', persistentVolumeClaim: { claimName: `${vm}-data` } }] } : {}),
            },
          },
        },
      });
      if (lb) {
        vmObjects.push({
          item: {
            plural: 'virtualmachineservices',
            object: {
              apiVersion: `vmoperator.vmware.com/${api}`,
              kind: 'VirtualMachineService',
              metadata: { name: `${vm}-lb`, namespace: ns },
              spec: { type: 'LoadBalancer', selector: { app: vm }, ports: ports.map((p) => ({ name: `tcp-${p}`, protocol: 'TCP', port: p, targetPort: p })) },
            },
          },
        });
      }
      const yaml = k8sYaml(vmObjects.map((d) => ({ comment: d.comment, object: d.item.object })));
      // The same checks create-vm.sh makes, before anything is sent: the image
      // is visible to the namespace (vmi) or cluster-wide (clustervmi), and the
      // VM class is bound (a warning: the create itself says whether it is).
      const vmPre = String.raw`var NS = ${JSON.stringify(ns)};
var VMOP = ${JSON.stringify(`vmoperator.vmware.com/${api}`)};
var IMAGE = ${JSON.stringify(image)};
var VM_CLASS = ${JSON.stringify(cls)};
if (IMAGE && !kubeGet(collectionPath(VMOP, NS, "virtualmachineimages") + "/" + encodeURIComponent(IMAGE)) && !kubeGet(collectionPath(VMOP, "", "clustervirtualmachineimages") + "/" + encodeURIComponent(IMAGE))) {
  throw new Error("Image " + IMAGE + " is not visible in " + NS + " (kubectl get vmi -n " + NS + "); nothing was created.");
}
if (!kubeGet(collectionPath(VMOP, NS, "virtualmachineclasses") + "/" + encodeURIComponent(VM_CLASS))) System.warn("VM class " + VM_CLASS + " is not listed in " + NS + "; the create will say whether it is bound.");`;
      const pkg = toPackage({
        packageName: packageNameOf('vcfa91', 'vm', ns, vm),
        description: `Creates the VM Service virtual machine ${vm} in the All Apps namespace ${ns}.`,
        categoryPath: `${AREA}/VM Service/${ns}/${vm}`,
        workflow: {
          name: `Create VM ${vm}`,
          description: `Creates, in namespace ${ns} through its Kubernetes API, ${vmObjects.map((d) => `the ${d.item.object.kind} ${d.item.object.metadata.name}`).join(', ')} — each that does not exist, in that order, never changing one that does. Stops first unless vmoperator.vmware.com/${api} is served and the image is visible. With the dryRun input set to true it validates each on the server (dryRun=All) and creates nothing.`,
          inputs: [DRY_RUN_INPUT],
          outputs: KUBE_OUTPUTS,
          script: kubeWorkflow({ resource: 'objects.json', served: [`vmoperator.vmware.com/${api}`], pre: vmPre }),
        },
        config: kubeConfig(`Create VM ${vm}`, '', vmObjects.length),
        resources: [{ name: 'objects.json', content: json(vmObjects.map((d) => d.item)) }],
      });

      const pre = [
        `NS=${q(ns)}`,
        `kubectl api-versions | grep -qx 'vmoperator.vmware.com/${api}' || { echo "vmoperator.vmware.com/${api} is not served here. kubectl api-versions | grep vmoperator shows what is." >&2; exit 2; }`,
        ...(image
          ? [`kubectl get vmi -n "$NS" '${image}' >/dev/null 2>&1 || kubectl get clustervmi '${image}' >/dev/null 2>&1 || { echo "Image ${image} is not visible in $NS (kubectl get vmi -n $NS)" >&2; exit 2; }`]
          : []),
        `kubectl get virtualmachineclass '${cls}' -n "$NS" >/dev/null 2>&1 || echo "warning: VM class ${cls} not listed in $NS — the dry run will say whether it is bound" >&2`,
        '',
      ];

      return {
        platform: PLATFORM,
        title: `VM Service VM ${vm} in ${ns}`,
        effect: 'reversible',
        trigger: { kind: 'request', detail: 'A project member creates it with kubectl through the VCF Automation endpoint, or a pipeline does.' },
        scope: {
          what: `One VM, ${vm}, of class ${cls} in namespace ${ns}${disk > 0 ? `, with a ${disk} GiB data disk` : ''}${lb ? `, behind a load balancer on ${ports.join(', ')}` : ''}.`,
          decidedBy: ['The kubectl context (organization, project, namespace), which the script checks.', `The namespace’s limits and the VM classes bound to it — ${cls} must be one.`, netKind === 'default' ? 'The namespace default network.' : `The ${netKind} ${netName} in the namespace’s VPC.`],
          ifWrong: 'A VM in the wrong namespace counts against another team’s limits and sits on their subnet; a load balancer on the wrong port exposes whatever listens there.',
        },
        guardrails: [
          { rule: 'Stops unless the current context is EXPECT_CONTEXT', because: 'The context is the scope; the same file creates the VM wherever kubectl points.' },
          { rule: `Stops unless vmoperator.vmware.com/${api} is served and the image is visible`, because: 'Both fail late otherwise — the VM object exists and sits unready with an event nobody reads.' },
          { rule: 'kubectl create, never apply', because: 'create refuses to overwrite an existing VM of the same name; apply would change its class or image in place.' },
          { rule: 'cloud-init sets no password and disables SSH password login', because: 'The Secret is readable by anyone who can read Secrets in the namespace.' },
        ],
        dryRun: ['Run the workflow with the dryRun input set to true to preview: each object is sent with dryRun=All, so class binding, image, storage class and quota are all checked, and nothing is created.', 'scripts/create-vm.sh --dry-run: the same server-side dry run.'],
        undo: [`kubectl delete -f ${vm}.k8s.yaml. The VM and its data disk are deleted with it.`],
        told: ['Kubernetes events on the VirtualMachine.', 'vCenter tasks for the VM, which VCF Operations collects.', 'The workflow log (AUDIT lines), its summary output and the webhook when set.'],
        requires: ['An All Apps namespace with the VM class, storage class and image available to it.', 'kubectl and the VCF CLI logged in to the namespace context.', ...(lb ? ['Avi load balancing delegated to the organization (9.1).'] : [])],
        files: {
          ...pkg.files,
          [`${vm}.k8s.yaml`]: yaml,
          'scripts/create-vm.sh': kubeScript(`Create VM ${vm} in ${ns}.`, pre, [`${vm}.k8s.yaml`], `kubectl delete -f ${vm}.k8s.yaml`),
          'IMPORT.md': importMd({
            subject: `The VM Service virtual machine ${vm} in ${ns}: an Orchestrator workflow that creates it through the namespace's Kubernetes API, and the same objects as ${vm}.k8s.yaml for kubectl.`,
            orgs: ALL_APPS,
            steps: [
              ...pkg.importSteps,
              kubeStep('Or: the virtual machine with kubectl', 'scripts/create-vm.sh', [`${vm}.k8s.yaml`], ['To offer it in the catalogue instead, wrap the manifest in a blueprint (formatVersion 2, a CCI.Supervisor.Resource whose manifest is this file) and import that through Build & Deploy → Content Hub → Blueprint Design → Blueprints → New From Import (VERIFY the resource type against a blueprint made in the designer).']),
            ],
            auth: ['kube', 'vcfa91'],
            verify: [
              `The vmoperator apiVersion: kubectl api-versions | grep vmoperator, and use the newest (VCF Automation 9.x examples use v1alpha5 — theaistack.blog, 2026). The workflow stops before sending anything if vmoperator.vmware.com/${api} is not served.`,
              'The resource names virtualmachineimages and clustervirtualmachineimages (kubectl vmi / clustervmi), virtualmachineclasses and virtualmachineservices are VM Operator\'s; kubectl api-resources --api-group=vmoperator.vmware.com lists them.',
              KUBE_VERIFY,
            ],
          }),
        },
        notes: [
          'VCF 9.x examples use vmoperator.vmware.com/v1alpha5; a 9.0 KB uses v1alpha3 for the same network interface shape. Pick whichever kubectl api-versions shows as newest.',
          'Use kubectl create at the VCF Automation endpoint: it rejects the last-applied annotation kubectl apply adds (theaistack.blog, 2026).',
          'spec.network.interfaces[].network names a Subnet or SubnetSet in the namespace (Broadcom KB 426105). Without it the VM goes on the namespace default.',
          'kubectl get vm <name> -n <namespace> -o jsonpath="{.status.network.primaryIP4}" gives the address once it is up.',
        ],
        findings,
      };
    },
  }),

  // -------------------------------------------------------------------------
  automationBlueprint({
    id: 'vcfa91_data_services',
    platform: PLATFORM,
    label: 'A Postgres or MySQL database from Data Services, with backups',
    group: 'VCF Automation 9.1 — consumption',
    description:
      'A database from VCF Data Services Manager, requested in an All Apps namespace: PostgresCluster or MySQLCluster (databases.dataservices.vmware.com) with VM class, storage, infrastructure policy, maintenance window and a backup schedule to a named backup location. The admin password goes into a Secret from a mode-600 file, never into the YAML.',
    inputs: [
      {
        id: 'engine',
        label: 'Engine',
        control: 'select',
        options: [
          { value: 'postgres', label: 'PostgreSQL' },
          { value: 'mysql', label: 'MySQL' },
        ],
        default: 'postgres',
      },
      { id: 'db_name', label: 'Name', control: 'text', default: 'orders-db' },
      { id: 'namespace', label: 'Namespace', control: 'text', default: 'team-a-prod-q4m8z' },
      { id: 'version', label: 'Version', control: 'text', default: '16', hint: 'As DSM offers it: 16 for Postgres, e.g. 8.0.41 for MySQL' },
      { id: 'vm_class', label: 'VM class', control: 'text', default: 'best-effort-medium' },
      { id: 'storage_policy', label: 'Storage policy', control: 'text', default: 'vSAN Default Storage Policy' },
      { id: 'storage_gib', label: 'Storage (GiB)', control: 'number', default: 50, min: 5, max: 16000 },
      {
        id: 'topology',
        label: 'Topology',
        control: 'select',
        options: [
          { value: 'single', label: 'Single node' },
          { value: 'ha', label: 'Highly available' },
        ],
        default: 'ha',
      },
      { id: 'infra_policy', label: 'Infrastructure policy', control: 'text', default: 'dsm-infra-policy', hint: 'Set by the provider in DSM' },
      { id: 'admin_user', label: 'Admin user', control: 'text', default: 'dbadmin' },
      { id: 'backup', label: 'Scheduled backups', control: 'toggle', default: true },
      { id: 'backup_location', label: 'Backup location', control: 'text', default: 'dsm-backups', showWhen: { input: 'backup', equals: ['true'] } },
      { id: 'retention_days', label: 'Keep backups (days)', control: 'number', default: 30, min: 1, max: 365, showWhen: { input: 'backup', equals: ['true'] } },
      { id: 'backup_cron', label: 'Full backup schedule (cron)', control: 'text', default: '59 23 * * 6', showWhen: { input: 'backup', equals: ['true'] } },
      {
        id: 'maintenance_day',
        label: 'Maintenance day',
        control: 'select',
        options: ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'].map((d) => ({ value: d, label: d[0] + d.slice(1).toLowerCase() })),
        default: 'SATURDAY',
      },
    ],
    automation: (values                 , name        )             => {
      const pg = str(values, 'engine', 'postgres') === 'postgres';
      const db = label(str(values, 'db_name', 'db'), 'db');
      const ns = str(values, 'namespace', 'team-a');
      const version = str(values, 'version', pg ? '16' : '8.0.41');
      const cls = str(values, 'vm_class', 'best-effort-medium');
      const sp = str(values, 'storage_policy', 'vSAN Default Storage Policy');
      const gib = num(values, 'storage_gib', 50);
      const ha = str(values, 'topology', 'ha') === 'ha';
      const infra = str(values, 'infra_policy', 'dsm-infra-policy');
      const user = str(values, 'admin_user', 'dbadmin');
      const backup = bool(values, 'backup', true);
      const loc = str(values, 'backup_location', 'dsm-backups');
      const days = num(values, 'retention_days', 30);
      const cron = str(values, 'backup_cron', '59 23 * * 6');
      const day = str(values, 'maintenance_day', 'SATURDAY');
      const kind = pg ? 'PostgresCluster' : 'MySQLCluster';
      const secret = `${db}-admin`;
      void name;

      const findings            = [];
      if (!backup) findings.push(warning('vcfa91.db.no-backup', 'No scheduled backup: a deleted or corrupted database cannot be recovered.', { remediation: 'Turn on backups to a backup location the provider has set up in DSM.', source: SRC }));
      if (backup && cron.split(/\s+/).length !== 5) findings.push(error('vcfa91.db.cron', `"${cron}" is not a five-field cron schedule.`, { source: SRC }));
      if (!ha) findings.push(info('vcfa91.db.single', 'A single-node database is down for the whole of every maintenance window and every host failure.', { source: SRC }));
      if (!pg) findings.push(info('vcfa91.db.mysql-ui', 'On 9.0.1 MySQL databases were made through kubectl only and did not appear in the VCF Automation UI.', { remediation: 'VERIFY on 9.1 whether they show under Data Services; manage them with kubectl either way.', source: 'Cormac Hogan, DSM 9.0.1 MySQL through VCF Automation' }));
      if (!pg && ha) findings.push(info('vcfa91.db.mysql-members', 'MySQL HA is three members.', { source: SRC }));

      const dbObject             = {
        plural: pg ? 'postgresclusters' : 'mysqlclusters',
        object: {
          apiVersion: 'databases.dataservices.vmware.com/v1alpha1',
          kind,
          metadata: { name: db, namespace: ns, labels: { 'vcf.automation/managed': 'true' } },
          spec: {
            version,
            adminUsername: user,
            adminPasswordRef: { name: secret },
            ...(pg ? { databaseName: db.replace(/-/g, '_'), replicas: ha ? 1 : 0 } : { members: ha ? 3 : 1 }),
            vmClass: { name: cls },
            storagePolicyName: sp,
            storageSpace: `${gib}Gi`,
            infrastructurePolicy: { name: infra },
            maintenanceWindow: { startDay: day, startTime: '23:59', duration: '6h' },
            ...(backup ? { backupLocation: { name: loc }, backupConfig: { backupRetentionDays: days, schedules: [{ name: 'full-weekly', schedule: cron, type: 'full' }] } } : {}),
          },
        },
      };
      const yaml = k8sYaml([{ comment: [`VERIFY: kubectl explain ${kind.toLowerCase()}.spec — field names follow DSM 9.0.x examples.`], object: dbObject.object }]);
      // The admin password Secret is made in the workflow from the SecureString,
      // so the password is in no file, resource or log.
      const dbPre = String.raw`var adminSecretName = ${JSON.stringify(secret)};
if (!settings.dbAdminPassword) throw new Error("Set dbAdminPassword in the configuration element " + SETTINGS_NAME + ": it becomes the Secret " + adminSecretName + " the database reads its admin password from.");
items.unshift({ plural: "secrets", object: { apiVersion: "v1", kind: "Secret", metadata: { name: adminSecretName, namespace: ${JSON.stringify(ns)} }, type: "Opaque", stringData: { username: ${JSON.stringify(user)}, password: String(settings.dbAdminPassword) } } });`;
      const pkg = toPackage({
        packageName: packageNameOf('vcfa91', 'db', ns, db),
        description: `Creates the ${pg ? 'PostgreSQL' : 'MySQL'} database ${db} from VCF Data Services Manager in the All Apps namespace ${ns}.`,
        categoryPath: `${AREA}/Data Services/${ns}/${db}`,
        workflow: {
          name: `Create database ${db}`,
          description: `Creates, in namespace ${ns} through its Kubernetes API, the Secret ${secret} with the admin password from the configuration element, then the ${kind} ${db} — each that does not exist, never changing one that does. Stops first unless databases.dataservices.vmware.com/v1alpha1 is served. With the dryRun input set to true it validates both on the server (dryRun=All) and creates nothing.`,
          inputs: [DRY_RUN_INPUT],
          outputs: KUBE_OUTPUTS,
          script: kubeWorkflow({ resource: 'database.json', served: ['databases.dataservices.vmware.com/v1alpha1'], pre: dbPre }),
        },
        config: kubeConfig(`Create database ${db}`, '', 2, [{ name: 'dbAdminPassword', type: 'SecureString', description: `The admin password of ${db}; it goes only into the Secret ${secret}` }]),
        resources: [{ name: 'database.json', content: json([dbObject]) }],
      });

      const pre = [
        `NS=${q(ns)}`,
        ': "${DB_ADMIN_PASSWORD_FILE:?set DB_ADMIN_PASSWORD_FILE to a mode-600 file holding the admin password}"',
        'PERM=$(stat -c %a "$DB_ADMIN_PASSWORD_FILE" 2>/dev/null || stat -f %Lp "$DB_ADMIN_PASSWORD_FILE")',
        '[[ "$PERM" == 600 || "$PERM" == 400 ]] || { echo "$DB_ADMIN_PASSWORD_FILE must be mode 600" >&2; exit 2; }',
        'kubectl api-versions | grep -qx databases.dataservices.vmware.com/v1alpha1 || { echo "Data Services is not available in this context" >&2; exit 2; }',
        `if ! kubectl get secret -n "$NS" '${secret}' >/dev/null 2>&1; then`,
        '  # The password is read from the file by kubectl; it is not an argument and not in any YAML.',
        `  kubectl create secret generic '${secret}' -n "$NS" --from-literal=username='${user}' --from-file=password="$DB_ADMIN_PASSWORD_FILE" "\${MODE[@]}"`,
        'fi',
      ];

      const check = kubeReadScript(`Check ${kind} ${db}: ready, and when it was last backed up.`, [
        `NS=${q(ns)}`,
        `kubectl get ${kind.toLowerCase()} '${db}' -n "$NS" -o wide || exit 1`,
        `READY=$(kubectl get ${kind.toLowerCase()} '${db}' -n "$NS" -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}')`,
        '[[ "$READY" == True ]] || { echo "Not Ready"; PROBLEMS=1; }',
        'echo "Connection:"',
        `kubectl get ${kind.toLowerCase()} '${db}' -n "$NS" -o jsonpath='{.status.connection}' ; echo`,
        ...(backup
          ? ['# VERIFY the backup resource name: kubectl api-resources --api-group=databases.dataservices.vmware.com', `kubectl get postgresbackups,mysqlbackups -n "$NS" 2>/dev/null | grep '${db}' | tail -3 || echo "  no backups listed yet"`]
          : ['echo "Backups are off for this database."', 'PROBLEMS=1']),
      ]);

      return {
        platform: PLATFORM,
        title: `${pg ? 'PostgreSQL' : 'MySQL'} ${db} in ${ns}`,
        effect: 'reversible',
        trigger: { kind: 'request', detail: 'A project member requests it with kubectl through the VCF Automation endpoint, or from the Data Services page in the organization portal.' },
        scope: {
          what: `One ${ha ? 'highly available' : 'single-node'} ${kind} named ${db}, ${gib} GiB on ${sp}, of class ${cls}.`,
          decidedBy: ['The kubectl context and namespace.', `The infrastructure policy ${infra}, which decides where DSM actually places the database VMs (an infrastructure namespace, not the team’s).`, 'The DSM data service policy that lets this organization use the engine and version.'],
          ifWrong: 'A database in the wrong namespace is owned and deletable by the wrong team; one without backups is one bad DELETE from gone.',
        },
        guardrails: [
          { rule: 'Stops unless the current context is EXPECT_CONTEXT', because: 'The context is the scope.' },
          { rule: 'Admin password only from a SecureString (Orchestrator) or a mode-600 file (script), into a Secret, never in YAML, a resource element, argv or a log', because: 'A password in a manifest ends up in Git.' },
          { rule: 'Stops if Data Services is not served in the context', because: 'Otherwise the error is a confusing "no matches for kind".' },
          { rule: 'kubectl create, not apply', because: 'apply to an existing database changes it in place — a version or class change is a restart.' },
        ],
        dryRun: ['Run the workflow with the dryRun input set to true to preview: the Secret and the database are sent with dryRun=All and nothing is created.', 'scripts/create-db.sh --dry-run: server-side dry run of the Secret and the database.', 'scripts/check-db.sh reads only.'],
        undo: [`kubectl delete ${kind.toLowerCase()} ${db} -n ${ns} deletes the database and its data. Backups are kept for their retention (VERIFY in DSM before relying on it).`],
        told: ['DSM’s own events and alerts, and VCF Operations if the DSM management pack is installed.', 'Kubernetes events on the object.'],
        requires: ['VCF Data Services Manager 9.x integrated with VCF Automation, with a data service policy for this organization.', ...(backup ? [`Backup location ${loc} configured in DSM.`] : []), 'kubectl logged in to the namespace.'],
        files: {
          ...pkg.files,
          [`${db}.k8s.yaml`]: yaml,
          'scripts/create-db.sh': kubeScript(`Create ${kind} ${db} in ${ns}.`, pre, [`${db}.k8s.yaml`], `kubectl delete ${kind.toLowerCase()} ${db} -n ${ns} — deletes the data.`),
          'scripts/check-db.sh': check,
          'IMPORT.md': importMd({
            subject: `The ${kind} ${db} in ${ns}: an Orchestrator workflow that creates its admin Secret and the database through the namespace's Kubernetes API, and the same object as ${db}.k8s.yaml for kubectl.`,
            orgs: ALL_APPS,
            steps: [
              ...pkg.importSteps,
              kubeStep('Or: the database with kubectl', 'scripts/create-db.sh', [`${db}.k8s.yaml`], ['The script creates the admin password Secret first, from DB_ADMIN_PASSWORD_FILE (a mode-600 file, given as an absolute path: the script works from the folder above scripts/), so the password is never on a command line or in the manifest.']),
              checkStep('check-db.sh', 'the database is Ready, and when it was last backed up.'),
            ],
            auth: ['kube', 'vcfa91'],
            verify: [`Field names follow the DSM 9.0.x examples; kubectl explain ${kind.toLowerCase()}.spec on your release is the check, and the resource name ${dbObject.plural} is kubectl api-resources --api-group=databases.dataservices.vmware.com.`, KUBE_VERIFY],
          }),
        },
        notes: [
          'Fields follow the DSM 9.0.x examples (Tom Fojta; Cormac Hogan): adminUsername, adminPasswordRef, version, storageSpace, storagePolicyName, infrastructurePolicy, vmClass, maintenanceWindow, backupLocation, backupConfig. Postgres takes replicas (0 single, 1 HA); MySQL takes members (1 or 3).',
          'Connection details appear under .status.connection once Ready; the password stays in the Secret.',
          'The 9.1 VCF Automation release notes do not list Data Services changes; the DSM release notes are where engine versions move.',
        ],
        findings,
      };
    },
  }),

  // -------------------------------------------------------------------------
  automationBlueprint({
    id: 'vcfa91_tags_placement',
    platform: PLATFORM,
    label: 'Tag-based placement from the fleet tag standard',
    group: 'VCF Automation 9.1 — governance',
    description:
      'Turns the vCenter tag standard (Environment, Tier, Application, DataClass…) into VCF Automation tags that line up: capability tags for each cloud zone, constraint snippets and inputs for templates, resource tags for deployments. Checks the result: constraints no zone can satisfy, standard values nobody can be placed on, and multiple-cardinality categories used for placement.',
    inputs: [
      {
        id: 'standard',
        label: 'Tag standard',
        control: 'textarea',
        default: 'Environment | single | Production, Staging, Development\nTier | single | Gold, Silver, Bronze\nApplication | multiple | web, database, backup\nDataClass | single | Public, Internal, Confidential',
        hint: 'Category | single|multiple | values, one category per line',
      },
      {
        id: 'zones',
        label: 'Cloud zones and what each offers',
        control: 'textarea',
        default: 'Production zone A: Environment=Production, Tier=Gold, DataClass=Confidential, DataClass=Internal\nProduction zone B: Environment=Production, Tier=Silver, DataClass=Internal\nNon-production zone: Environment=Staging, Environment=Development, Tier=Bronze, DataClass=Internal, DataClass=Public',
        hint: 'Zone name: Category=Value, …',
      },
      { id: 'constraints', label: 'Template constraints', control: 'text', default: 'Environment=${input.environment}:hard, Tier=${input.tier}:soft', hint: 'Category=Value or ${input.x}, then :hard or :soft' },
      {
        id: 'key_case',
        label: 'Capability and constraint tags',
        control: 'select',
        options: [
          { value: 'as-is', label: 'exactly as the standard spells them (Environment:Production)' },
          { value: 'lower', label: 'lower-case (environment:production); resource tags stay as the standard spells them' },
        ],
        default: 'as-is',
        hint: 'Resource tags always use the standard’s exact case: VCF Automation writes them to vCenter as tags, and a different case is a different category there',
      },
      { id: 'write_zone_tags', label: 'Write the script that applies zone tags', control: 'toggle', default: true },
    ],
    automation: (values                 , name        )             => {
      const lower = str(values, 'key_case', 'as-is') === 'lower';
      // Capability and constraint tags: VCF Automation's own, matched against each other.
      const norm = (s        ) => (lower ? s.trim().toLowerCase().replace(/\s+/g, '-') : s.trim());
      const writeZones = bool(values, 'write_zone_tags', true);
      void name;
      const findings            = [];

                                                                              
      const standard             = [];
      for (const line of str(values, 'standard', '').split('\n').map((l) => l.trim()).filter(Boolean)) {
        const [cat = '', card = '', vals = ''] = line.split('|').map((p) => p.trim());
        if (!cat || !/^(single|multiple)$/i.test(card)) {
          findings.push(warning('vcfa91.tags.standard-line', `Could not read "${line}".`, { remediation: 'Category | single|multiple | value, value', source: SRC }));
          continue;
        }
        standard.push({ name: cat, multiple: /multiple/i.test(card), values: listOf(vals) });
      }
      const catOf = (n        ) => standard.find((c) => c.name.toLowerCase() === n.trim().toLowerCase());
      // The standard's own spelling of a category and a value, whatever case they were typed in here.
      const keyOf = (k        ) => catOf(k)?.name ?? k.trim();
      const valueOf = (k        , v        ) => catOf(k)?.values.find((x) => x.toLowerCase() === v.trim().toLowerCase()) ?? v.trim();
      if (lower) {
        const spaced = standard.flatMap((c) => c.values.filter((v) => /\s/.test(v)).map((v) => `${c.name}=${v}`));
        if (spaced.length > 0) findings.push(warning('vcfa91.tags.lower-spaces', `${spaced.join(', ')} contain spaces. Lower-case mode writes zone tags with hyphens, but to_lower() in the template does not replace spaces, so those constraints match no zone.`, { remediation: 'Use the standard’s exact case instead, or values without spaces.', source: SRC }));
      }

                                                                             
      const zones         = [];
      for (const line of str(values, 'zones', '').split('\n').map((l) => l.trim()).filter(Boolean)) {
        const at = line.indexOf(':');
        if (at < 0) {
          findings.push(warning('vcfa91.tags.zone-line', `Could not read "${line}".`, { remediation: 'Zone name: Category=Value, …', source: SRC }));
          continue;
        }
        const tags = listOf(line.slice(at + 1)).map((pair) => {
          const [k = '', v = ''] = pair.split('=').map((p) => p.trim());
          return { key: k, value: v };
        });
        for (const t of tags) {
          const c = catOf(t.key);
          if (!c) findings.push(warning('vcfa91.tags.unknown-category', `Zone "${line.slice(0, at)}" uses ${t.key}, which is not in the tag standard.`, { source: SRC }));
          else if (!c.values.some((v) => v.toLowerCase() === t.value.toLowerCase())) findings.push(warning('vcfa91.tags.unknown-value', `Zone "${line.slice(0, at)}": ${t.key}=${t.value} is not a value the standard allows.`, { remediation: `Allowed: ${c.values.join(', ')}.`, source: SRC }));
        }
        zones.push({ name: line.slice(0, at).trim(), tags });
      }

                                                                                            
      const constraints               = listOf(str(values, 'constraints', '')).map((c) => {
        const hard = !/:soft$/i.test(c);
        const body = c.replace(/:(hard|soft)$/i, '');
        const eq = body.indexOf('=');
        const key = eq < 0 ? body.trim() : body.slice(0, eq).trim();
        const value = eq < 0 ? '' : body.slice(eq + 1).trim();
        return { key, value, hard, templated: /^\$\{input\.[A-Za-z0-9_]+\}$/.test(value) };
      });

      const has = (z      , key        , value        ) => z.tags.some((t) => t.key.toLowerCase() === key.toLowerCase() && t.value.toLowerCase() === value.toLowerCase());

      // Constraints no zone can satisfy.
      for (const c of constraints) {
        const cat = catOf(c.key);
        if (!cat) {
          findings.push(warning('vcfa91.tags.constraint-category', `The constraint on ${c.key} names a category not in the standard.`, { source: SRC }));
          continue;
        }
        if (cat.multiple) {
          findings.push(
            warning('vcfa91.tags.multiple-placement', `${cat.name} is a multiple-cardinality category and is used for placement.`, {
              remediation: 'A cluster can carry several values of it, so a constraint on one value matches clusters meant for another. Place on single-cardinality categories (Environment, Tier) and keep multiple ones for reporting.',
              source: SRC,
            }),
          );
        }
        const candidates = c.templated ? cat.values : [c.value];
        for (const v of candidates) {
          if (!zones.some((z) => has(z, c.key, v))) {
            const msg = c.templated ? `A request with ${c.key}=${v} (an allowed input value) matches no cloud zone.` : `The constraint ${c.key}=${v} matches no cloud zone.`;
            const extra = { remediation: c.templated ? `Remove ${v} from the input’s allowed values, or tag a zone with it.` : 'Tag a zone with it, or fix the constraint.', source: SRC };
            findings.push(c.hard && !c.templated ? error('vcfa91.tags.unsatisfiable', msg, extra) : c.hard ? warning('vcfa91.tags.unserved-value', msg, extra) : info('vcfa91.tags.soft-unmatched', `${msg} It is soft, so placement falls back silently.`, extra));
          }
        }
      }
      // All literal hard constraints together.
      const literalHard = constraints.filter((c) => c.hard && !c.templated && c.value);
      if (literalHard.length > 1 && !zones.some((z) => literalHard.every((c) => has(z, c.key, c.value)))) {
        findings.push(error('vcfa91.tags.unsatisfiable-together', `No single zone has all of ${literalHard.map((c) => `${c.key}=${c.value}`).join(', ')}.`, { remediation: 'Hard constraints must all be met by one zone.', source: SRC }));
      }

      const tagText = (k        , v        ) => `${norm(keyOf(k))}:${norm(valueOf(k, v))}`;
      const placementCats = [...new Set(constraints.filter((c) => c.templated).map((c) => c.key))].map((k) => catOf(k)).filter((c)                => c !== undefined);
      const inputName = (c            ) => (c.templated ? c.value.replace(/^\$\{input\.|\}$/g, '') : '');

      // A templated constraint value: the input as the requester picked it (the
      // standard's exact spelling), lower-cased in the expression when the
      // capability tags are lower-case.
      const constraintValue = (c            ) => (c.templated ? (lower ? `\${to_lower(input.${inputName(c)})}` : c.value) : lower ? norm(c.value) : valueOf(c.key, c.value));
      const snippet = [
        '# Paste into a VM Apps cloud template (formatVersion 1).',
        '# The inputs offer only the values the tag standard allows, spelt exactly as the',
        '# standard spells them, so a request cannot ask for a tag no zone has.',
        'inputs:',
        ...constraints.filter((c) => c.templated).flatMap((c) => {
          const cat = catOf(c.key);
          return [`  ${inputName(c)}:`, '    type: string', `    title: ${cat?.name ?? c.key}`, '    enum:', ...(cat?.values ?? []).map((v) => `      - ${q(v)}`)];
        }),
        'resources:',
        '  machine:',
        '    type: Cloud.vSphere.Machine',
        '    properties:',
        `      # Placement: hard must match, soft is preferred. Matched against the zones' capability tags${lower ? ', which are lower-case: to_lower() makes the request match them' : ', in the same case'}.`,
        '      constraints:',
        ...constraints.map((c) => `        - tag: ${q(`${norm(c.key)}:${constraintValue(c)}${c.hard ? '' : ':soft'}`)}`),
        '      # Resource tags: stamped on the deployed VM and, on vSphere, written to vCenter',
        '      # as tags — key as the category, value as the tag. So they use the tag',
        '      # standard’s exact case: "environment" next to "Environment" would be a',
        '      # second category in vCenter, and half the estate would be tagged in each.',
        '      tags:',
        ...standard.filter((c) => !c.multiple).map((c) => {
          const con = constraints.find((x) => x.key.toLowerCase() === c.name.toLowerCase() && x.templated);
          return `        - key: ${q(c.name)}\n          value: ${q(con ? con.value : `<REQUIRED — one of ${c.values.join(', ')}>`)}`;
        }),
        '',
      ].join('\n');

      const csv = [
        'vcenter_category,cardinality,vcenter_value,capability_tag,resource_tag,used_for_placement',
        ...standard.flatMap((c) => c.values.map((v) => `${JSON.stringify(c.name)},${c.multiple ? 'MULTIPLE' : 'SINGLE'},${JSON.stringify(v)},${JSON.stringify(tagText(c.name, v))},${JSON.stringify(`${c.name}:${v}`)},${placementCats.includes(c) || constraints.some((x) => x.key.toLowerCase() === c.name.toLowerCase()) ? 'yes' : 'no'}`)),
        '',
      ].join('\n');

      const zoneJson = json(zones.map((z) => ({ zone: z.name, tags: z.tags.map((t) => ({ key: norm(keyOf(t.key)), value: norm(valueOf(t.key, t.value)) })) })));

      const required = constraints.filter((c) => c.hard).flatMap((c) => {
        const cat = catOf(c.key);
        return (c.templated ? cat?.values ?? [] : [c.value]).map((v) => tagText(c.key, v));
      });

      const check = restScript({
        purpose: 'Check that every tag a hard template constraint can ask for is carried by at least one cloud zone.',
        scope: 'tenant',
        act: false,
        body: [
          `REQUIRED=(${required.map(q).join(' ')})`,
          "Z=$(get '/iaas/api/zones?$top=500' application/json)",
          'echo "Cloud zones and their capability tags:"',
          "jq -r '.content[] | \"  \\(.name): \\([.tags[]? | \"\\(.key):\\(.value)\"] | join(\", \"))\"' <<<\"$Z\"",
          'PROBLEMS=0',
          'for t in "${REQUIRED[@]}"; do',
          '  k="${t%%:*}"; v="${t#*:}"',
          "  jq -e --arg k \"$k\" --arg v \"$v\" '[.content[] | select(any(.tags[]?; .key == $k and .value == $v))] | length > 0' <<<\"$Z\" >/dev/null \\",
          '    || { echo "NO ZONE carries ${t} — requests asking for it will fail placement"; PROBLEMS=$((PROBLEMS+1)); }',
          'done',
          'exit $(( PROBLEMS > 0 ? 1 : 0 ))',
        ],
      });

      const apply = restScript({
        purpose: 'Add the capability tags in zone-tags.json to each cloud zone, keeping the tags it already has.',
        scope: 'tenant',
        act: true,
        body: [
          'HERE=$(cd "$(dirname "$0")/.." && pwd)',
          '# The update sends the whole zone, not only its tags: the zone update',
          '# (ZoneSpecification) requires name and regionId on older IaaS API releases,',
          '# and a body with tags alone is refused there or, worse, clears other fields.',
          '# VERIFY: the IaaS API reference documents PATCH /iaas/api/zones/{id}; set',
          '# VCFA_ZONE_METHOD=PUT if your release documents PUT for it instead.',
          'ZONE_METHOD="${VCFA_ZONE_METHOD:-PATCH}"',
          "Z=$(get '/iaas/api/zones?$top=500' application/json)",
          'COUNT=$(jq length "$HERE/zone-tags.json")',
          'for i in $(seq 0 $((COUNT-1))); do',
          "  NAME=$(jq -r --argjson i \"$i\" '.[$i].zone' \"$HERE/zone-tags.json\")",
          "  ID=$(jq -r --arg n \"$NAME\" '[.content[] | select(.name == $n)] | if length == 1 then .[0].id else empty end' <<<\"$Z\")",
          '  [[ -n "$ID" ]] || { echo "Zone \\"$NAME\\": not found, or more than one — skipped" >&2; continue; }',
          '  # The zone as it is now, read fresh, is both the base of the update and the undo.',
          '  CUR=$(get "/iaas/api/zones/${ID}" application/json)',
          "  REGION=$(jq -r '.regionId // ((._links.region.href // \"\") | split(\"/\") | last) // empty' <<<\"$CUR\")",
          '  [[ -n "$REGION" ]] || { echo "Zone ${NAME}: GET /iaas/api/zones/${ID} shows no region id; skipped rather than sending a zone without one" >&2; continue; }',
          '  # Union of what is there and what the standard says: nothing is removed.',
          "  jq --arg r \"$REGION\" --argjson i \"$i\" --slurpfile want \"$HERE/zone-tags.json\" \\",
          "    '{name, description, regionId: $r, placementPolicy, folder, customProperties, tagsToMatch,",
          "      tags: (((.tags // []) + $want[0][$i].tags) | unique_by(.key + \":\" + (.value // \"\")))} | with_entries(select(.value != null))' \\",
          '    <<<"$CUR" > "$HERE/.zone-$i.json"',
          "  ADDED=$(jq -r --argjson cur \"$CUR\" '[.tags[] | \"\\(.key):\\(.value // \"\")\"] - [$cur.tags[]? | \"\\(.key):\\(.value // \"\")\"] | join(\", \")' \"$HERE/.zone-$i.json\")",
          '  echo "Zone ${NAME}: adding ${ADDED:-nothing}"',
          '  [[ -n "$ADDED" ]] || continue',
          '  # The diff of the zone as sent: only tags lines should change.',
          "  zone_lines() { jq -r '({name, description, placementPolicy, folder, customProperties, tagsToMatch} | tojson), ((.tags // []) | sort_by(.key, .value)[] | \"tag \\(.key):\\(.value // \"\")\")'; }",
          "  diff <(zone_lines <<<\"$CUR\") <(zone_lines < \"$HERE/.zone-$i.json\") | grep '^[<>]' | sed 's/^/    /' || true",
          '  if (( ! DRY_RUN )); then',
          '    BACKUP="$HERE/zone-before-${ID}-$(date -u +%Y%m%dT%H%M%SZ).json"',
          '    printf \'%s\\n\' "$CUR" > "$BACKUP"',
          '    echo "  previous zone saved to ${BACKUP}"',
          '  fi',
          '  send "$ZONE_METHOD" "/iaas/api/zones/${ID}" "$HERE/.zone-$i.json" application/json',
          'done',
          'rm -f "$HERE"/.zone-*.json',
        ],
        undo: 'Each changed zone was saved first to zone-before-<id>-<time>.json. Send its tags back the same way (the same fields, tags from the saved file) to remove what was added.',
      });

      // The fragment, made into a whole template so it can be imported and tried.
      const exampleTemplate = snippet
        .replace(/^inputs:\n(?=resources:)/m, '')
        .replace('\n    properties:\n', '\n    properties:\n      image: "<REQUIRED — an image mapping name>"\n      flavor: "<REQUIRED — a flavor mapping name>"\n');
      const exampleArtifact = { name: 'Tag placement example', description: 'Placement constraints and resource tags from the tag standard.', yaml: exampleTemplate };
      const imported = importBundle({ templates: [exampleArtifact] });
      const pkg = toPackage({
        packageName: packageNameOf('vcfa91', 'tag', 'placement'),
        description: `Adds the tag standard's capability tags to ${zones.length} cloud zone(s), checks every hard constraint can be met, and imports the example template.`,
        categoryPath: `${AREA}/Tag placement`,
        workflow: {
          name: 'Tag placement',
          description: `VM Apps organization. ${writeZones ? 'Adds the capability tags in zone-tags.json to each cloud zone named (exactly one match, or it is skipped), keeping every tag the zone has and sending the whole zone read fresh. ' : ''}Checks that every tag a hard template constraint can ask for is on some zone, and fails the run when one is not. With projectId set, imports the example template through the blueprint API — validated, created or its draft updated, then versioned (released only if releaseTemplate is true). Set the dryRun input to true to preview without changing anything.`,
          inputs: [{ name: 'dryRun', type: 'boolean', description: 'true: report what would change and change nothing' }],
          outputs: [
            { name: 'missingTags', type: 'string', description: 'Tags a hard constraint can ask for that no zone carries' },
            { name: 'summary', type: 'string', description: 'The audit record, JSON' },
          ],
          script: tagPlacementWorkflow(writeZones, { name: exampleArtifact.name, description: exampleArtifact.description, version: '1.0.0' }),
        },
        config: {
          name: 'Settings',
          description: 'Settings of the Tag placement workflow. Fill vcfaOrg, vcfaApiToken and (to import the template) projectId after import; set dryRun to false only after a dry run.',
          attributes: [
            VCFA_HOST_ATTR,
            ORG_ATTR(''),
            TOKEN_ATTR('an organization administrator of the VM Apps organization'),
            { name: 'projectId', type: 'string', value: '', description: 'Project the example template is imported into (GET /iaas/api/projects); empty: not imported' },
            { name: 'releaseTemplate', type: 'boolean', value: false, description: 'Release the imported version to the catalog' },
            { name: 'zoneMethod', type: 'string', value: 'PATCH', description: 'PATCH (the IaaS API reference) or PUT for the zone update' },
            ...GUARD_ATTRS(zones.length + 3),
            WEBHOOK_ATTR,
          ],
        },
        resources: [
          { name: 'zone-tags.json', content: zoneJson },
          { name: 'required-tags.json', content: json([...new Set(required)]) },
          // The same bytes as import/templates/<name>/blueprint.yaml.
          { name: 'example-template.yaml', content: blueprintYaml(exampleArtifact), mimeType: 'text/plain' },
        ],
      });

      return {
        platform: PLATFORM,
        title: `Tag placement from a ${standard.length}-category standard across ${zones.length} zone(s)`,
        effect: 'reversible',
        trigger: { kind: 'manual', detail: 'When the tag standard changes, a zone is added, or a template is written: regenerate and re-run the workflow (or the check).' },
        scope: {
          what: `${writeZones ? `Capability tags on ${zones.length} cloud zone(s), added and never removed` : 'No zone is changed'}; the example template "${exampleArtifact.name}" in the project named by projectId, when it is set; snippets for copying.`,
          decidedBy: ['The zone names, matched exactly — one match or the zone is skipped.', 'The tag standard: only its categories and values are written.', 'The organization the token belongs to, and the project in projectId.'],
          ifWrong: 'A capability tag on the wrong zone lets production requests land on it: placement is by tag, not by name, and it is silent.',
        },
        guardrails: [
          ...(writeZones
            ? [
                { rule: 'Tags are added to what the zone has, never replaced', because: 'Replacing a zone’s tags drops the ones other templates rely on, and their next request fails placement.' },
                { rule: 'A zone name must match exactly one zone, or it is skipped', because: 'Two zones called "Production" is how production tags end up on the lab.' },
                { rule: 'Dry run by default, printing each tag it would add (the script also the diff of the zone it would send)', because: 'The diff is small and readable, so it gets read — and it shows nothing but tags changes.' },
                { rule: 'Reads the zone fresh and sends it whole (name, regionId and every other field); the script saves the previous zone first, the workflow logs it', because: 'A body with only tags is refused by releases that require name and regionId, or resets fields it leaves out; the saved copy is the undo.' },
              ]
            : []),
          { rule: 'The template is validated first, updated only when its draft differs, and a version that exists is left alone; it is released only when releaseTemplate is true', because: 'Versions are immutable and a release reaches every catalog that imports the template.' },
          { rule: 'At most cap changes per run; the first failure stops it', because: 'A run against the wrong organization stops early rather than tagging every zone.' },
        ],
        dryRun: ['Run the Tag placement workflow with the dryRun input set to true to preview: it logs every tag it would add and the template it would create or version.', writeZones ? 'scripts/apply-zone-tags.sh --dry-run prints, per zone, the tags it would add.' : 'No zone is changed.', 'scripts/check-tags.sh reads only and exits 1 if a hard constraint can ask for a tag no zone has.'],
        undo: ['Each zone as it was is in the workflow log (and saved to zone-before-<id>-<time>.json by the script) before it is changed; send that zone back (its tags, with name and regionId) to remove what was added. Deployments already placed stay where they are.', 'The template: unrelease the version, or DELETE /blueprint/api/blueprints/{id} while nothing is deployed from it.'],
        told: ['VCF Automation audit of the zone change.', 'The workflow log (AUDIT lines), its summary output and the webhook when set; a run fails when a hard constraint cannot be met.', 'scripts/check-tags.sh output, which can run on a schedule and fail when someone untags a zone.'],
        requires: ['A VM Apps organization with cloud zones, and an organization token (see "API tokens").', 'The vCenter tag standard, with cardinality, as it is actually configured.'],
        files: {
          ...pkg.files,
          'zone-tags.json': zoneJson,
          'template-constraints.yaml': snippet,
          'tag-mapping.csv': csv,
          'scripts/check-tags.sh': check,
          ...(writeZones ? { 'scripts/apply-zone-tags.sh': apply } : {}),
          ...imported.files,
          'IMPORT.md': importMd({
            subject: 'Tag-based placement: capability tags on the cloud zones, and a template whose constraints match them — one Orchestrator workflow for both, or the scripts and the template import by hand.',
            steps: [
              ...pkg.importSteps,
              ...(writeZones ? [manualStep('Or: zone capability tags from a Linux host', ['`./scripts/apply-zone-tags.sh` saves each zone first, then sends the tags it adds; with `--dry-run` it only prints, per zone, the tags it would add and the diff of the zone. By hand: Infrastructure → Cloud Zones → the zone → Capability tags.'])] : []),
              checkStep('check-tags.sh', 'a hard constraint that can ask for a tag no zone carries.'),
              imported.steps.templates,
              manualStep('Use it in your own templates', ['template-constraints.yaml is the fragment to paste into existing templates; the imported example is the same fragment made whole. Fill its image and flavor before versioning it.']),
            ],
            auth: ['vcfa91', 'import'],
            verify: [
              ...verifyFor(imported),
              'The workflow imports the template through the same blueprint API calls as import/import-templates.sh (POST /blueprint/api/blueprint-validation, GET/POST/PUT /blueprint/api/blueprints, POST …/versions), with the VM Apps organization token. Capability tags and cloud zones are VM Apps objects.',
              'The zone update method (PATCH, or PUT with the zoneMethod setting / VCFA_ZONE_METHOD) and to_lower() in expressions are VERIFY; see the notes.',
            ],
          }),
        },
        notes: [
          'Three kinds of tag (drpranayjha.com, VCF Automation 9 series part 13): capability tags say what a zone, compute, network or storage profile offers; constraint tags in a template say what a request needs (hard by default, :soft to prefer, ! to exclude); resource tags are stamped on what is deployed.',
          'vCenter tags on clusters are collected as key:value on the compute and can be matched by a cloud zone’s tag filter directly, so the vCenter category and the VCF Automation key should be the same word, in the same case. tag-mapping.csv is that table.',
          'Resource tags on a vSphere machine are written to vCenter as tags: the key becomes the category and the value the tag (the Assembler tagging tutorial shows a deployed machine’s tags appearing on the VM in vCenter). That is why template-constraints.yaml writes resource tags with the standard’s exact case whatever the capability-tag case: environment:production would create a category "environment" beside "Environment". VERIFY on your release: whether an existing category is matched by exact name, and the cardinality VCF Automation gives a category it creates — a key matching a single-cardinality category cannot take a second value.',
          lower
            ? 'Capability and constraint tags are lower-case here; the template lower-cases the requester’s choice with to_lower() so it matches. VERIFY that your release has to_lower() in cloud template expressions, and how it compares tag case, before relying on it.'
            : 'Capability, constraint and resource tags all use the standard’s exact case, so one spelling runs from vCenter through placement to the deployed VM.',
          'The zone update sends the whole zone read fresh from GET /iaas/api/zones/{id}, with regionId taken from the zone (or its region link). VERIFY: the method — PATCH is what the IaaS API reference lists for updating a zone; VCFA_ZONE_METHOD=PUT switches it.',
          'Capability tags and cloud zones belong to VM Apps organizations. All Apps organizations place by region, zone and namespace class; the resource tags still apply to what they deploy.',
        ],
        findings,
      };
    },
  }),

  // -------------------------------------------------------------------------
  automationBlueprint({
    id: 'vcfa91_blueprint_versions',
    platform: PLATFORM,
    label: 'Template versions, release, and moving a template between organizations',
    group: 'VCF Automation 9.1 — catalogue',
    description:
      'The lifecycle of a cloud template (a "blueprint" in the API) in VCF Automation 9: export it with its versions, create a new version with a change log, release it so the catalogue offers it, and import it into another organization’s project — refusing duplicates at each step. Flags the templates that cannot move between VM Apps and All Apps organizations.',
    inputs: [
      { id: 'template_name', label: 'Template', control: 'text', default: 'Standard Linux server' },
      { id: 'version', label: 'New version', control: 'text', default: '1.4.0' },
      { id: 'change_log', label: 'Change log', control: 'text', default: 'Pin image to rhel9-2026-09; lease 60 days' },
      { id: 'release', label: 'Release it to the catalogue', control: 'toggle', default: true },
      { id: 'import_to', label: 'Also import into organization', control: 'text', default: '', placeholder: 'team-b', hint: 'Empty: no import' },
      {
        id: 'source_type',
        label: 'Source organization is',
        control: 'select',
        options: [
          { value: 'vm-apps', label: 'VM Apps' },
          { value: 'all-apps', label: 'All Apps' },
        ],
        default: 'vm-apps',
      },
      {
        id: 'target_type',
        label: 'Target organization is',
        control: 'select',
        options: [
          { value: 'vm-apps', label: 'VM Apps' },
          { value: 'all-apps', label: 'All Apps' },
        ],
        default: 'vm-apps',
        showWhen: { input: 'import_to', notEquals: [''] },
      },
    ],
    automation: (values                 , name        )             => {
      const tpl = str(values, 'template_name', 'Template');
      const version = str(values, 'version', '1.0.0');
      const changeLog = str(values, 'change_log', '');
      const release = bool(values, 'release', true);
      const target = str(values, 'import_to', '');
      const srcType = str(values, 'source_type', 'vm-apps');
      const tgtType = str(values, 'target_type', 'vm-apps');
      const base = slugOf(tpl, 'template');
      void name;

      const findings            = [];
      if (!/^\d+\.\d+(\.\d+)?$/.test(version)) findings.push(warning('vcfa91.bp.version', `"${version}" is not a numeric version.`, { remediation: 'Versions sort as strings in some views; 1.10 lands before 1.9. Use major.minor.patch.', source: SRC }));
      if (!changeLog) findings.push(warning('vcfa91.bp.no-changelog', 'No change log: the next person cannot tell what this version changed.', { source: SRC }));
      if (target && srcType !== tgtType) {
        findings.push(
          warning('vcfa91.bp.cross-type', `Moving a template from a ${srcType === 'vm-apps' ? 'VM Apps' : 'All Apps'} to a${tgtType === 'all-apps' ? 'n All Apps' : ' VM Apps'} organization.`, {
            remediation: 'VM Apps templates use Cloud.vSphere.* / Cloud.NSX.* resources placed through cloud zones; All Apps templates use CCI / Supervisor resources (VirtualMachine, namespaces, VKS). The import will be accepted and fail at request time. Rewrite the resources for the target.',
            source: SRC,
          }),
        );
      }
      if (target && !LABEL.test(target)) findings.push(warning('vcfa91.bp.target', `"${target}" does not look like an organization login name.`, { source: SRC }));

      const versionPayload = { version, description: changeLog, changeLog, release };

      const exportScript = restScript({
        purpose: `Export template "${tpl}" and its version list from the organization in VCFA_ORG.`,
        scope: 'tenant',
        act: false,
        body: [
          `NAME=${q(tpl)}`,
          'HERE=$(cd "$(dirname "$0")/.." && pwd); mkdir -p "$HERE/export"',
          '# The name filter is loose; the exact match is done here.',
          "B=$(get \"/blueprint/api/blueprints?name=$(jq -rn --arg n \"$NAME\" '$n|@uri')&size=100\" application/json)",
          "MATCH=$(jq --arg n \"$NAME\" '[.content[] | select(.name == $n)]' <<<\"$B\")",
          "case $(jq length <<<\"$MATCH\") in 1) ;; 0) echo \"No template named \\\"$NAME\\\"\"; exit 1;; *) echo \"More than one template named \\\"$NAME\\\" — export by id instead\"; exit 1;; esac",
          "ID=$(jq -r '.[0].id' <<<\"$MATCH\")",
          'get "/blueprint/api/blueprints/${ID}" application/json > "$HERE/export/' + base + '.json"',
          "jq -r '.content' \"$HERE/export/" + base + ".json\" > \"$HERE/export/" + base + ".yaml\"",
          'get "/blueprint/api/blueprints/${ID}/versions?size=100" application/json > "$HERE/export/' + base + '-versions.json"',
          'echo "Exported ${NAME} (${ID}) to export/' + base + '.yaml"',
          "jq -r '.content[]? | \"  \\(.version)\\t\\(.status // \"\")\\t\\(.createdAt // \"\")\"' \"$HERE/export/" + base + "-versions.json\"",
        ],
      });

      const versionScript = restScript({
        purpose: `Create version ${version} of "${tpl}"${release ? ' and release it' : ''}, unless that version already exists.`,
        scope: 'tenant',
        act: true,
        body: [
          `NAME=${q(tpl)}; VERSION=${q(version)}`,
          'HERE=$(cd "$(dirname "$0")/.." && pwd)',
          "B=$(get \"/blueprint/api/blueprints?name=$(jq -rn --arg n \"$NAME\" '$n|@uri')&size=100\" application/json)",
          "ID=$(jq -r --arg n \"$NAME\" '[.content[] | select(.name == $n)] | if length == 1 then .[0].id else empty end' <<<\"$B\")",
          '[[ -n "$ID" ]] || { echo "Template \\"$NAME\\" not found, or not unique" >&2; exit 2; }',
          'V=$(get "/blueprint/api/blueprints/${ID}/versions?size=200" application/json)',
          "if jq -e --arg v \"$VERSION\" 'any(.content[]?; .version == $v)' <<<\"$V\" >/dev/null; then",
          '  echo "Version ${VERSION} already exists — versions are immutable; pick the next number." >&2; exit 2',
          'fi',
          "echo \"Current versions: $(jq -r '[.content[]?.version] | join(\", \")' <<<\"$V\")\"",
          `send POST "/blueprint/api/blueprints/\${ID}/versions" "$HERE/${base}-version.json" application/json`,
          ...(release ? ['# release: true in the payload releases it. Content sources that import this template pick it up at their next sync.'] : ['echo "Not released: the catalogue still offers the previous released version."']),
        ],
        undo: 'Unrelease: POST /blueprint/api/blueprints/{id}/versions/{version}/actions/unrelease. A version cannot be deleted while deployments use it.',
      });

      const importScript = restScript({
        purpose: `Import export/${base}.yaml into a project of organization ${target || '<target>'}, unless a template of that name is already there.`,
        scope: 'tenant',
        act: true,
        body: [
          `NAME=${q(tpl)}`,
          ...(target ? [`[[ "$VCFA_ORG" == ${q(target)} ]] || { echo "VCFA_ORG is $VCFA_ORG; this import is for ${target}. Use that organization's token file." >&2; exit 2; }`] : []),
          ': "${TARGET_PROJECT_ID:?set TARGET_PROJECT_ID — GET /iaas/api/projects in the target organization}"',
          'HERE=$(cd "$(dirname "$0")/.." && pwd)',
          `[[ -f "$HERE/export/${base}.yaml" ]] || { echo "Run export-template.sh against the source organization first" >&2; exit 2; }`,
          "B=$(get \"/blueprint/api/blueprints?name=$(jq -rn --arg n \"$NAME\" '$n|@uri')&size=100\" application/json)",
          "if jq -e --arg n \"$NAME\" 'any(.content[]; .name == $n)' <<<\"$B\" >/dev/null; then",
          '  echo "A template named \\"$NAME\\" already exists in $VCFA_ORG — add a version there instead of a second copy." >&2; exit 2',
          'fi',
          `jq -n --arg n "$NAME" --arg p "$TARGET_PROJECT_ID" --rawfile c "$HERE/export/${base}.yaml" \\`,
          "  '{name: $n, description: \"\", projectId: $p, requestScopeOrg: false, content: $c}' > \"$HERE/.import.json\"",
          'send POST /blueprint/api/blueprints "$HERE/.import.json" application/json',
          'rm -f "$HERE/.import.json"',
          'echo "Imported as a draft. Test it in the target, then create and release a version there."',
        ],
        undo: 'DELETE /blueprint/api/blueprints/{id} in the target organization, while it has no deployments.',
      });

      const pkg = toPackage({
        packageName: packageNameOf('vcfa91', 'template', base),
        description: `Creates version ${version} of the template "${tpl}"${release ? ' and releases it' : ''}${target ? `, and imports it into organization ${target}` : ''}.`,
        categoryPath: `${AREA}/Templates/${base}`,
        workflow: {
          name: `Version template ${base}`,
          description: `VM Apps organization (the blueprint API). Finds the one template named "${tpl}", exports its YAML (output templateYaml), creates version ${version} with its change log${release ? ' and releases it' : ''} unless that version exists${target ? `, then — with the token of ${target} — creates it as a draft in targetProjectId unless a template of that name is already there` : ''}. Set the dryRun input to true to preview without changing anything.`,
          inputs: [{ name: 'dryRun', type: 'boolean', description: 'true: report what would be created and change nothing' }],
          outputs: [
            { name: 'templateId', type: 'string', description: 'The source template id' },
            { name: 'templateYaml', type: 'string', description: 'Its YAML as exported: keep it, it is the undo' },
            { name: 'importedId', type: 'string', description: 'The template id in the target organization, when one is named' },
            { name: 'summary', type: 'string', description: 'The audit record, JSON' },
          ],
          script: templateVersionWorkflow(),
        },
        config: {
          name: 'Settings',
          description: `Settings of the Version template ${base} workflow. Fill vcfaOrg and vcfaApiToken${target ? `, and targetApiToken and targetProjectId for ${target},` : ''} after import; set dryRun to false only after a dry run.`,
          attributes: [
            VCFA_HOST_ATTR,
            ORG_ATTR(''),
            TOKEN_ATTR('a template author in the source organization'),
            ...(target
              ? [
                  { name: 'targetApiToken', type: 'SecureString'         , description: `An API token of ${target}, whose project receives the copy` },
                  { name: 'targetProjectId', type: 'string'         , value: '', description: `The project in ${target} (GET /iaas/api/projects with its token)` },
                ]
              : []),
            ...GUARD_ATTRS(target ? 2 : 1),
            WEBHOOK_ATTR,
          ],
        },
        resources: [
          { name: 'template.json', content: json({ name: tpl, target }) },
          { name: 'version.json', content: json(versionPayload) },
        ],
      });

      return {
        platform: PLATFORM,
        title: `Template "${tpl}" version ${version}${target ? `, imported into ${target}` : ''}`,
        effect: 'reversible',
        trigger: { kind: 'manual', detail: 'A template author finishing a change, or a platform team promoting a template from a build organization to a consuming one.' },
        scope: {
          what: `The template "${tpl}" in the source organization${target ? `, and a new draft copy in a project of ${target}` : ''}.`,
          decidedBy: ['The organization in VCFA_ORG and its token.', 'The template name, matched exactly and required to be unique.', release ? 'Every project and content source that imports released versions of it.' : 'Nobody else: the version is unreleased.'],
          ifWrong: 'A released version goes to every catalogue that imports the template, at the next sync — a bad release is a catalogue-wide change.',
        },
        guardrails: [
          { rule: 'Refuses a version number that already exists', because: 'Versions are the audit trail; reusing one hides what changed.' },
          { rule: 'Name must match exactly one template, or it stops', because: 'Two templates with the same name in different projects is common; versioning the wrong one releases it.' },
          ...(target ? [{ rule: `Import refuses when VCFA_ORG is not ${target} or the name already exists there`, because: 'An import with the wrong token lands in the source organization as a duplicate.' }] : []),
          { rule: 'Dry run by default', because: 'The script reads first and says what it would post.' },
        ],
        dryRun: ['Run the workflow with the dryRun input set to true to preview: it looks everything up, exports the YAML and logs what it would post.', 'scripts/export-template.sh reads only.', 'scripts/version-template.sh and scripts/import-template.sh with --dry-run look everything up and stop before posting.'],
        undo: ['Unrelease the version (POST …/versions/{version}/actions/unrelease). Deployments made from it keep their version.', ...(target ? ['Delete the imported draft in the target.'] : [])],
        told: ['The template’s version history in the design canvas.', 'The catalog item changes at the next content source sync.', 'The workflow log (AUDIT lines), its summary output and the webhook when set.'],
        requires: ['An organization token for the source (and one for the target) — see "API tokens".', 'The template already exists in the source organization.'],
        files: {
          ...pkg.files,
          'scripts/export-template.sh': exportScript,
          [`${base}-version.json`]: json(versionPayload),
          'scripts/version-template.sh': versionScript,
          ...(target ? { 'scripts/import-template.sh': importScript } : {}),
          'IMPORT.md': importMd({
            subject: `Version ${version} of the template "${tpl}"${target ? `, and a copy imported into ${target}` : ''}: one Orchestrator workflow through the blueprint API, or the scripts.`,
            orgs: 'VCF Automation 9.1 / 9.1.1 organizations (VM Apps; All Apps where /blueprint/api answers)',
            steps: [
              ...pkg.importSteps,
              manualStep('Or: export (read only)', ['`./scripts/export-template.sh` writes export/<template>.yaml and its version list. Keep them: they are the undo.']),
              manualStep('Version', [`\`./scripts/version-template.sh\` looks the template up by exact name and stops if version ${version} exists, otherwise posts \`${base}-version.json\`${release ? ', which releases it' : ''}; \`--dry-run\` stops before posting. By hand: the design page → Version, ${release ? 'with Release to catalog ticked' : 'then release it from Version History when ready'}.`]),
              ...(target
                ? [manualStep(`Import into ${target}`, [`With VCFA_ORG=${target} and that organization’s token, \`TARGET_PROJECT_ID=<id> ./scripts/import-template.sh\` creates the draft there; \`--dry-run\` stops before posting. By hand in the target: ${tgtType === 'all-apps' ? 'Build & Deploy → Content Hub → Blueprint Design → Blueprints → New From Import' : 'Design → Templates → New from → Upload'}, choosing export/<template>.yaml.`])]
                : []),
              manualStep('Templates from this page', ['Every template blueprint here also writes import/templates/<name>/blueprint.yaml with its own import/import-templates.sh, which creates or updates, versions and (with --release) releases in one pass.']),
            ],
            auth: ['vcfa91'],
            verify: [
              'The /blueprint/api paths are the 8.18 API (blueprints, versions with {version, description, changeLog, release}), which VM Apps organizations keep. Under a 9.x All Apps organization token they are VERIFY; the UI routes are documented (Broadcom 9.1, Import and Export a Blueprint).',
              ...(target ? [`The import logs in to ${target} with its own API token (targetApiToken): a template made with the source organization's token would land in the source organization.`] : []),
            ],
          }),
        },
        notes: [
          'Paths are the /blueprint/api carried over from 8.x: GET /blueprint/api/blueprints, GET/POST /blueprint/api/blueprints/{id}/versions ({version, description, changeLog, release}). VERIFY they answer under a 9.x tenant token for your organization type.',
          'The catalogue shows released versions only; the requester picks among them unless the content source is set to the latest.',
          'In All Apps organizations templates are written in formatVersion 2 with CCI resource types. They are the same service underneath but not the same resource vocabulary as VM Apps.',
          'Export keeps the YAML, not the project, custom forms or property group ids; re-create those in the target.',
        ],
        findings,
      };
    },
  }),

  // -------------------------------------------------------------------------
  automationBlueprint({
    id: 'vcfa91_namespace_day2',
    platform: PLATFORM,
    label: 'Change a namespace after it exists: limits, VM classes, storage, shared subnets',
    group: 'VCF Automation 9.1 — consumption',
    description:
      'Day-2 on a Supervisor namespace, new in 9.1: raise or lower its CPU and memory limits in a zone, add VM classes or storage classes, attach organization shared subnets. Saves the namespace as it was before touching it, validates the change server-side, and only then applies.',
    inputs: [
      { id: 'namespace', label: 'Namespace', control: 'text', default: 'team-a-dev-x7k2p' },
      { id: 'zone', label: 'Zone', control: 'text', default: 'zone-a' },
      { id: 'cpu_limit_mhz', label: 'New CPU limit (MHz)', control: 'number', default: 30000, min: 0, max: 100000000, hint: '0 leaves it' },
      { id: 'memory_limit_mib', label: 'New memory limit (MiB)', control: 'number', default: 98304, min: 0, max: 1000000000, hint: '0 leaves it' },
      { id: 'vm_classes', label: 'VM classes to allow', control: 'text', default: '', placeholder: 'best-effort-large', hint: 'Empty leaves them' },
      { id: 'storage_class', label: 'Storage class to set', control: 'text', default: '', placeholder: 'vsan-default-storage-policy' },
      { id: 'storage_limit_gib', label: 'Its limit (GiB)', control: 'number', default: 0, min: 0, max: 10000000, showWhen: { input: 'storage_class', notEquals: [''] } },
      { id: 'shared_subnets', label: 'Shared subnets to attach', control: 'text', default: '', placeholder: 'shared-mgmt' },
    ],
    automation: (values                 , name        )             => {
      const ns = str(values, 'namespace', 'team-a');
      const zone = str(values, 'zone', 'zone-a');
      const cpu = num(values, 'cpu_limit_mhz', 0);
      const mem = num(values, 'memory_limit_mib', 0);
      const classes = listOf(str(values, 'vm_classes', ''));
      const sc = str(values, 'storage_class', '');
      const scGib = num(values, 'storage_limit_gib', 0);
      const subnets = listOf(str(values, 'shared_subnets', ''));
      void name;

      const findings            = [];
      const changes = (cpu > 0 || mem > 0 ? 1 : 0) + (classes.length ? 1 : 0) + (sc ? 1 : 0) + (subnets.length ? 1 : 0);
      if (changes === 0) findings.push(error('vcfa91.nsday2.nothing', 'Nothing is being changed.', { source: SRC }));
      if (sc && scGib === 0) findings.push(warning('vcfa91.nsday2.sc-unlimited', `Storage class ${sc} is added with no limit.`, { source: SRC }));
      findings.push(info('vcfa91.nsday2.fields', 'The patch field names follow the Terraform vcfa_supervisor_namespace overrides. VERIFY with kubectl explain supervisornamespace.spec — the server-side dry run rejects unknown fields.', { source: SRC }));

      const patch = {
        spec: {
          initialClassConfigOverrides: {
            ...(cpu > 0 || mem > 0 ? { zones: [{ name: zone, ...(cpu > 0 ? { cpuLimit: `${cpu}M` } : {}), ...(mem > 0 ? { memoryLimit: `${mem}Mi` } : {}) }] } : {}),
            ...(classes.length ? { vmClasses: classes.map((c) => ({ name: c })) } : {}),
            ...(sc ? { storageClasses: [{ name: sc, ...(scGib > 0 ? { limit: `${scGib}Gi` } : {}) }] } : {}),
          },
          ...(subnets.length ? { sharedSubnetNames: subnets } : {}),
        },
      };

      const script = [
        '#!/usr/bin/env bash',
        `# Change namespace ${ns}: saves it first, checks with a server-side dry run, then applies (--dry-run stops after the check).`,
        'set -euo pipefail',
        'command -v kubectl >/dev/null || { echo "kubectl is required" >&2; exit 2; }',
        ': "${EXPECT_CONTEXT:?set EXPECT_CONTEXT to the organization/project context that owns the namespace}"',
        '[[ "$(kubectl config current-context)" == "$EXPECT_CONTEXT" ]] || { echo "Wrong context: $(kubectl config current-context)" >&2; exit 2; }',
        `NS=${q(ns)}`,
        'HERE=$(cd "$(dirname "$0")/.." && pwd)',
        'STAMP=$(date +%Y%m%d-%H%M%S)',
        '# VERIFY the resource name: kubectl api-resources | grep -i supervisornamespace',
        'kubectl get supervisornamespace "$NS" -o yaml > "$HERE/before-${NS}-${STAMP}.yaml" || { echo "Could not read $NS — not changing what could not be saved" >&2; exit 2; }',
        'echo "Saved the current namespace to before-${NS}-${STAMP}.yaml"',
        'kubectl patch supervisornamespace "$NS" --type merge --patch-file "$HERE/patch.json" --dry-run=server -o yaml > /dev/null',
        'echo "Server-side dry run passed."',
        'if [[ " $* " == *" --dry-run "* ]]; then echo "Dry run: nothing changed. Run it without --dry-run to apply."; exit 0; fi',
        'kubectl patch supervisornamespace "$NS" --type merge --patch-file "$HERE/patch.json"',
        '',
        '# Undo: kubectl replace -f before-<namespace>-<stamp>.yaml (after removing status and resourceVersion), or patch the old values back.',
        '',
      ].join('\n');

      const pkg = toPackage({
        packageName: packageNameOf('vcfa91', 'namespace', ns),
        description: `Changes the existing Supervisor namespace ${ns} (VCF Automation 9.1 day 2).`,
        categoryPath: `${AREA}/Namespaces/${ns}`,
        workflow: {
          name: `Change namespace ${label(ns, 'namespace')}`,
          description: `All Apps organization. Reads the SupervisorNamespace ${ns} through /cci/kubernetes (output before: the undo), leaves it alone if it already has every value in patch.json, otherwise runs a server-side dry run of the merge patch and then applies it (with the dryRun input set to true it stops after the check).`,
          inputs: [{ name: 'dryRun', type: 'boolean', description: 'true: read, validate on the server, and change nothing' }],
          outputs: [
            { name: 'before', type: 'string', description: 'The namespace as it was, JSON: the undo' },
            { name: 'summary', type: 'string', description: 'The audit record, JSON' },
          ],
          script: namespaceDay2Workflow(ns),
        },
        config: {
          name: 'Settings',
          description: 'Settings of the namespace day-2 workflow. Fill vcfaOrg, vcfaApiToken and project after import; set dryRun to false only after a dry run.',
          attributes: [
            VCFA_HOST_ATTR,
            ORG_ATTR(''),
            TOKEN_ATTR('an account allowed to edit namespaces in the project'),
            { name: 'project', type: 'string', value: '', description: `The VCF Automation project that owns ${ns}` },
            ...GUARD_ATTRS(1),
            WEBHOOK_ATTR,
          ],
        },
        resources: [{ name: 'patch.json', content: json(patch) }],
      });

      return {
        platform: PLATFORM,
        title: `Day-2 change to namespace ${ns}`,
        effect: 'reversible',
        trigger: { kind: 'request', detail: 'A project team that has outgrown its namespace, or an administrator tightening one.' },
        scope: {
          what: `Namespace ${ns}: ${[cpu || mem ? `limits in ${zone}` : '', classes.length ? `VM classes ${classes.join(', ')}` : '', sc ? `storage class ${sc}` : '', subnets.length ? `shared subnets ${subnets.join(', ')}` : ''].filter(Boolean).join('; ') || 'nothing'}.`,
          decidedBy: ['The namespace named, in the checked context.', 'The organization’s region quota, which a raised limit must still fit in.', 'The namespace class, which bounds what a day-2 change may ask for (VERIFY on your release).'],
          ifWrong: 'A lowered limit below current use leaves running workloads unable to restart; a shared subnet attached to the wrong namespace joins it to another network.',
        },
        guardrails: [
          { rule: 'The namespace is saved to a file before any change, or nothing happens', because: 'The previous limits are the undo, and nobody remembers them.' },
          { rule: 'Server-side dry run every time, before the real patch', because: 'Quota and class checks happen on the server; a typo in a field name fails here rather than half-applying.' },
          { rule: 'Stops unless the current context is EXPECT_CONTEXT', because: 'Namespace names are unique only within an organization.' },
        ],
        dryRun: ['The workflow reads the namespace and runs the server-side dry run of the patch every time; it patches unless the dryRun input is set to true.', 'scripts/change-namespace.sh --dry-run: saves the namespace and runs the dry run only.'],
        undo: ['Patch the old values back from the workflow\'s before output (or its log line), or apply the saved before-*.yaml from the script.'],
        told: ['vCenter events for the namespace limit change.', 'Kubernetes events on the SupervisorNamespace.', 'The workflow log (AUDIT lines), its summary output and the webhook when set.'],
        requires: ['VCF Automation 9.1 (namespace day-2 changes are new in 9.1).', 'Rights to edit namespaces in the project.'],
        files: {
          ...pkg.files,
          'patch.json': json(patch),
          'scripts/change-namespace.sh': script,
          'IMPORT.md': importMd({
            subject: `A change to the existing namespace ${ns}: an Orchestrator workflow that patches the SupervisorNamespace through the VCF Automation Kubernetes API, or the kubectl script.`,
            orgs: ALL_APPS,
            steps: [
              ...pkg.importSteps,
              manualStep('Or: change it with kubectl', ['`./scripts/change-namespace.sh` saves the namespace as it is, runs a server-side dry run of patch.json, then applies the patch; `--dry-run` stops after the check. The saved copy is the undo.']),
            ],
            auth: ['kube', 'vcfa91'],
            verify: [
              'The SupervisorNamespace path — https://<vcfa>/cci/kubernetes/apis/infrastructure.cci.vmware.com/v1alpha3/namespaces/<project>/supervisornamespaces/<name> — is the go-vcloud-director v3 SDK\'s (ccitypes.KubernetesSubpath and SupervisorNamespacesURL), which the vmware/vcfa provider uses with the same organization bearer token.',
              'VERIFY the field names in patch.json with kubectl explain supervisornamespace.spec: the SDK names the Go field ClassConfigOverrides (zones with cpuLimit and memoryLimit, vmClasses, storageClasses with limit) and SharedSubnetNames; the JSON key of the overrides (initialClassConfigOverrides here, as in the Terraform provider) is the one to confirm. The server-side dry run rejects an unknown field before anything changes.',
            ],
          }),
        },
        notes: ['9.1 what’s new: application teams can change resource limits, VM classes, storage classes and shared subnets on existing namespaces.', 'The existing "A Supervisor namespace, requested from All Apps" blueprint creates namespaces; this one changes them.'],
        findings,
      };
    },
  }),

  // -------------------------------------------------------------------------
  automationBlueprint({
    id: 'vcfa91_argocd',
    platform: PLATFORM,
    label: 'Argo CD for a namespace, and an application it syncs',
    group: 'VCF Automation 9.1 — consumption',
    description:
      'GitOps on VCF: an Argo CD instance in a vSphere namespace (the Argo CD Supervisor Service, or 9.1.1’s Argo CD as a VCF Service in tech preview) and an Application that syncs a Git path into a namespace or a VKS cluster, with automatic sync off unless asked for.',
    inputs: [
      {
        id: 'mode',
        label: 'Installed as',
        control: 'select',
        options: [
          { value: 'supervisor', label: 'Argo CD Supervisor Service' },
          { value: 'vcf-service', label: 'Argo CD as a VCF Service (9.1.1, tech preview)' },
        ],
        default: 'supervisor',
      },
      { id: 'instance', label: 'Instance name', control: 'text', default: 'argocd' },
      { id: 'namespace', label: 'Namespace for Argo CD', control: 'text', default: 'team-a-gitops-k3v9s' },
      { id: 'version', label: 'Argo CD version', control: 'text', default: '3.0.19+vmware.1-vks.1', hint: 'X.Y.Z+vmware.W-vks.V' },
      { id: 'app_name', label: 'Application', control: 'text', default: 'orders' },
      { id: 'repo_url', label: 'Git repository', control: 'text', default: 'https://git.example.com/team-a/orders-deploy.git' },
      { id: 'repo_path', label: 'Path', control: 'text', default: 'overlays/prod' },
      { id: 'revision', label: 'Revision', control: 'text', default: 'main' },
      { id: 'destination', label: 'Deploy to cluster', control: 'text', default: 'team-a-prod-01', hint: 'As added with argocd cluster add' },
      { id: 'dest_namespace', label: 'Target namespace in it', control: 'text', default: 'orders' },
      { id: 'auto_sync', label: 'Sync automatically', control: 'toggle', default: false },
      { id: 'prune', label: 'Delete what is removed from Git', control: 'toggle', default: false, showWhen: { input: 'auto_sync', equals: ['true'] } },
    ],
    automation: (values                 , name        )             => {
      const vcfService = str(values, 'mode', 'supervisor') === 'vcf-service';
      const inst = label(str(values, 'instance', 'argocd'), 'argocd');
      const ns = str(values, 'namespace', 'gitops');
      const version = str(values, 'version', '');
      const app = label(str(values, 'app_name', 'app'), 'app');
      const repo = str(values, 'repo_url', '');
      const path = str(values, 'repo_path', '.');
      const rev = str(values, 'revision', 'main');
      const dest = str(values, 'destination', 'in-cluster');
      const destNs = str(values, 'dest_namespace', 'default');
      const auto = bool(values, 'auto_sync', false);
      const prune = auto && bool(values, 'prune', false);
      void name;

      const findings            = [];
      if (!/^\d+\.\d+\.\d+\+vmware\.\d+-vks\.\d+$/.test(version)) findings.push(error('vcfa91.argo.version', `"${version}" does not match X.Y.Z+vmware.W-vks.V, which the ArgoCD resource requires.`, { remediation: 'kubectl explain argocd.spec.version shows the pattern; the service’s release notes list the versions.', source: SRC }));
      if (vcfService) findings.push(warning('vcfa91.argo.preview', 'Argo CD as a VCF Service is a tech preview in 9.1.1.', { remediation: 'Not for production. It supports up to 30 vSphere namespaces per instance.', source: 'VCF Automation 9.1.1 release notes' }));
      if (/^http:\/\//.test(repo)) findings.push(warning('vcfa91.argo.http', 'The repository is plain HTTP.', { source: SRC }));
      if (prune) findings.push(warning('vcfa91.argo.prune', 'Automatic sync with prune deletes anything removed from Git, including by a bad merge.', { remediation: 'Keep prune manual for stateful applications, or protect them with the Prune=false annotation.', source: SRC }));
      findings.push(info('vcfa91.argo.k8s-lag', 'Argo CD support for a new Kubernetes minor version lags VKS by two to four months.', { remediation: 'Check the VKS version of the target cluster is supported before upgrading it.', source: 'VCF Automation 9.1.1 release notes' }));

      const instance = [
        '# VERIFY apiVersion and spec: kubectl explain argocd.spec',
        'apiVersion: argocd-service.vsphere.vmware.com/v1alpha1',
        'kind: ArgoCD',
        'metadata:',
        `  name: ${inst}`,
        `  namespace: ${ns}`,
        'spec:',
        `  version: ${q(version)}`,
        '',
      ].join('\n');

      const application = [
        '# Apply into the Argo CD instance, after argocd login and argocd cluster add.',
        'apiVersion: argoproj.io/v1alpha1',
        'kind: Application',
        'metadata:',
        `  name: ${app}`,
        `  namespace: ${ns}`,
        'spec:',
        '  project: default',
        '  source:',
        `    repoURL: ${repo}`,
        `    path: ${path}`,
        `    targetRevision: ${rev}`,
        '  destination:',
        `    name: ${dest}`,
        `    namespace: ${destNs}`,
        '  syncPolicy:',
        ...(auto ? ['    automated:', `      prune: ${prune}`, '      selfHeal: true'] : ['    # Manual: argocd app sync ' + app + ' after reading argocd app diff ' + app]),
        '    syncOptions:',
        '      - CreateNamespace=true',
        '',
      ].join('\n');

      const install = kubeScript(`Create Argo CD instance ${inst} in ${ns}.`, [], ['argocd-instance.k8s.yaml'], `kubectl delete argocd ${inst} -n ${ns} — the Applications it manages keep running; only the controller goes.`);

      // The same two objects as the YAML files, for the workflow.
      const argoObjects               = [
        { plural: 'argocds', object: { apiVersion: 'argocd-service.vsphere.vmware.com/v1alpha1', kind: 'ArgoCD', metadata: { name: inst, namespace: ns }, spec: { version } } },
        {
          plural: 'applications',
          object: {
            apiVersion: 'argoproj.io/v1alpha1',
            kind: 'Application',
            metadata: { name: app, namespace: ns },
            spec: {
              project: 'default',
              source: { repoURL: repo, path, targetRevision: rev },
              destination: { name: dest, namespace: destNs },
              syncPolicy: { ...(auto ? { automated: { prune, selfHeal: true } } : {}), syncOptions: ['CreateNamespace=true'] },
            },
          },
        },
      ];
      // The Application only when asked: Argo CD must already know the target
      // cluster (argocd cluster add), which the workflow cannot do.
      const argoPre = String.raw`if (settings.createApplication !== true) {
  items = [items[0]];
  System.log("createApplication is off: create the Application with scripts/connect-and-create-app.sh once the instance is up and the target cluster is added.");
} else {
  requireServed("argoproj.io/v1alpha1");
}`;
      const pkg = toPackage({
        packageName: packageNameOf('vcfa91', 'argocd', ns, inst),
        description: `Creates the Argo CD instance ${inst} in the All Apps namespace ${ns}, and optionally the Application ${app}.`,
        categoryPath: `${AREA}/Argo CD/${ns}/${inst}`,
        workflow: {
          name: `Create Argo CD ${inst}`,
          description: `Creates, in namespace ${ns} through its Kubernetes API, the ArgoCD instance ${inst} (version ${version}) unless it exists; with createApplication set, then the Argo CD Application ${app} (${auto ? `automatic sync${prune ? ' with prune' : ''}` : 'manual sync'}) unless it exists. With the dryRun input set to true it validates on the server (dryRun=All) and creates nothing.`,
          inputs: [DRY_RUN_INPUT],
          outputs: KUBE_OUTPUTS,
          script: kubeWorkflow({ resource: 'objects.json', served: ['argocd-service.vsphere.vmware.com/v1alpha1'], pre: argoPre }),
        },
        config: kubeConfig(`Create Argo CD ${inst}`, '', 2, [{ name: 'createApplication', type: 'boolean', value: false, description: `Also create the Application ${app}; only after argocd cluster add for ${dest}` }]),
        resources: [{ name: 'objects.json', content: json(argoObjects) }],
      });

      const connect = [
        '#!/usr/bin/env bash',
        `# After the instance is up: log in, change the admin password, add the target cluster, create ${app}.`,
        'set -euo pipefail',
        'command -v argocd >/dev/null || { echo "the argocd CLI is required" >&2; exit 2; }',
        `NS=${q(ns)}`,
        `SERVER=$(kubectl get svc -n "$NS" -o jsonpath='{.items[?(@.spec.type=="LoadBalancer")].status.loadBalancer.ingress[0].ip}')`,
        '[[ -n "$SERVER" ]] || { echo "No LoadBalancer address yet for Argo CD in $NS" >&2; exit 2; }',
        'echo "Argo CD at $SERVER. Log in as admin; the initial password is in the argocd-initial-admin-secret Secret:"',
        `echo "  kubectl get secret -n $NS argocd-initial-admin-secret -o jsonpath='{.data.password}' | base64 -d"`,
        'argocd login "$SERVER" --username admin --sso=false --grpc-web',
        'echo "Change it now:"; argocd account update-password',
        `echo "Add the target cluster (its kubeconfig context must be current in kubectl: vcf cluster kubeconfig get ${dest}):"`,
        `echo "  argocd cluster add <kubeconfig-context> --name ${dest}"`,
        'if [[ " $* " != *" --dry-run "* ]]; then',
        '  argocd app create -f "$(dirname "$0")/../application.yaml" --upsert=false',
        `  argocd app diff ${app} || true`,
        'else',
        '  echo "DRY RUN: would create the application from application.yaml. Run it without --dry-run to create it."',
        'fi',
        '',
        `# Undo: argocd app delete ${app} --cascade=false keeps what it deployed; --cascade deletes it too.`,
        '',
      ].join('\n');

      return {
        platform: PLATFORM,
        title: `Argo CD ${inst} in ${ns}, syncing ${app}`,
        effect: 'reversible',
        trigger: { kind: auto ? 'commit' : 'manual', detail: auto ? `Every commit to ${rev} under ${path} is synced to ${dest} within the refresh interval (three minutes by default).` : `A person runs argocd app sync ${app} after reading the diff.`, worstCase: auto ? 'once per refresh interval, with whatever is on the branch' : undefined },
        scope: {
          what: `Argo CD in ${ns}; the application ${app} writing to namespace ${destNs} of cluster ${dest}.`,
          decidedBy: [`The Git path ${path} at ${rev}: whatever manifests are there.`, `The credentials Argo CD holds for ${dest}, which decide what it may create there.`, 'The Argo CD project (default here), which can restrict destinations and kinds.'],
          ifWrong: 'The default project allows any destination and any kind; a manifest for the wrong namespace or a ClusterRole is applied as written.',
        },
        guardrails: [
          { rule: 'Stops unless the current context is EXPECT_CONTEXT', because: 'The instance is created in the namespace the context points at.' },
          { rule: auto ? `Automatic sync${prune ? ' with prune' : ' without prune'}` : 'Manual sync — a person reads argocd app diff first', because: auto ? (prune ? 'Chosen: deletions in Git are deletions in the cluster.' : 'Removed resources are reported as out of sync, not deleted.') : 'A bad merge is caught at the diff rather than in production.' },
          { rule: 'The application is created only when none of that name exists, and never upserts over an existing one', because: 'An upsert silently repoints an existing application at a different repository.' },
          { rule: 'The admin password is changed at first login', because: 'The initial password sits in a Secret anyone with read access to the namespace can decode.' },
        ],
        dryRun: ['Run the workflow with the dryRun input set to true to preview: each object is sent with dryRun=All and nothing is created.', 'scripts/install-argocd.sh --dry-run: server-side dry run.', 'scripts/connect-and-create-app.sh --dry-run logs in and stops before creating the application.'],
        undo: [`argocd app delete ${app} --cascade=false keeps the deployed resources.`, `kubectl delete argocd ${inst} -n ${ns} removes Argo CD itself.`],
        told: ['Argo CD’s own history per application, and its notifications if configured.', 'Git history, which is the record of what was deployed.', 'The workflow log (AUDIT lines), its summary output and the webhook when set.'],
        requires: [vcfService ? 'VCF Automation 9.1.1 with Argo CD installed through Provider Management → Service Management.' : 'The Argo CD Supervisor Service installed on the Supervisor (1.2.0 adds auto-discovery of VKS clusters).', 'The argocd CLI, kubectl and the VCF CLI.', `Read access to ${repo || 'the repository'} for Argo CD.`],
        files: {
          ...pkg.files,
          'argocd-instance.k8s.yaml': instance,
          'application.yaml': application,
          'scripts/install-argocd.sh': install,
          'scripts/connect-and-create-app.sh': connect,
          'IMPORT.md': importMd({
            subject: `Argo CD instance ${inst} in ${ns}, and the application ${app}: an Orchestrator workflow that creates them through the namespace's Kubernetes API, and the YAML and scripts for kubectl and the argocd CLI.`,
            orgs: ALL_APPS,
            steps: [
              ...pkg.importSteps,
              kubeStep('Or: the Argo CD instance with kubectl', 'scripts/install-argocd.sh', ['argocd-instance.k8s.yaml']),
              manualStep('Connect and create the application', ['When the instance is up, `./scripts/connect-and-create-app.sh` logs in with the argocd CLI, has you change the admin password, adds the target cluster and creates the application from application.yaml. After the cluster is added, the workflow can create the application instead: set createApplication to true and run it again.']),
            ],
            auth: ['kube', 'vcfa91'],
            verify: [
              'The ArgoCD resource apiVersion (argocd-service.vsphere.vmware.com/v1alpha1), its resource name argocds and the version string follow a 9.0.2 example: kubectl api-resources | grep -i argocd. The workflow stops before sending anything if the group is not served.',
              'VERIFY: creating the Application as an argoproj.io/v1alpha1 object in the instance namespace (the declarative Argo CD route) through the namespace endpoint; if the namespace does not serve argoproj.io to you, keep createApplication off and use the argocd CLI.',
              KUBE_VERIFY,
            ],
          }),
        },
        notes: [
          'The ArgoCD resource and version pattern follow the VCF 9.0.2 Argo CD service example (kimjohansson.se): argocd-service.vsphere.vmware.com/v1alpha1, spec.version X.Y.Z+vmware.W-vks.V.',
          '9.1.1: Argo CD as a VCF Service authenticates with VCF Automation credentials and is deployed by organization administrators to vSphere namespaces, up to 30 per instance.',
          'For a VKS cluster, get its kubeconfig with vcf cluster kubeconfig get <cluster>, then argocd cluster add. The Supervisor Service 1.2.0 can attach VKS clusters automatically by policy.',
        ],
        findings,
      };
    },
  }),

  // -------------------------------------------------------------------------
  automationBlueprint({
    id: 'vcfa91_security_policy',
    platform: PLATFORM,
    label: 'A vDefend firewall policy for VMs in a namespace',
    group: 'VCF Automation 9.1 — networking',
    description:
      'Distributed firewall for an All Apps namespace, which 9.1 lets the provider delegate to organizations: an NSX operator SecurityPolicy that selects VMs by label, allows the flows listed and — by default — drops everything else inbound to them.',
    inputs: [
      { id: 'namespace', label: 'Namespace', control: 'text', default: 'team-a-prod-q4m8z' },
      { id: 'policy_name', label: 'Policy name', control: 'text', default: 'web-tier' },
      { id: 'applied_to', label: 'Applies to VMs labelled', control: 'text', default: 'app=web01' },
      {
        id: 'rules',
        label: 'Rules',
        control: 'textarea',
        default: 'from 10.0.0.0/8 tcp/443\nfrom app=bastion tcp/22',
        hint: '[allow|drop|reject] from <label=value or IPv4/IPv6 CIDR> [to <label=value or CIDR>] <tcp|udp>/<port[-port]> or any; one per line, allow when no action is given',
      },
      { id: 'default_drop', label: 'Drop all other inbound traffic', control: 'toggle', default: true },
      { id: 'priority', label: 'Priority', control: 'number', default: 10, min: 0, max: 1000, hint: 'Lower is evaluated first' },
      { id: 'gateway_firewall', label: 'Also a gateway firewall policy on the transit gateway', control: 'toggle', default: false },
      { id: 'nsx_project', label: 'NSX project of the organization', control: 'text', default: 'team-a', showWhen: { input: 'gateway_firewall', equals: ['true'] } },
      { id: 'tgw', label: 'Transit gateway', control: 'text', default: 'default', showWhen: { input: 'gateway_firewall', equals: ['true'] } },
      {
        id: 'gateway_rules',
        label: 'Gateway rules',
        control: 'textarea',
        default: 'ALLOW | any | 203.0.113.20/32 | tcp/443\nALLOW | 10.10.0.0/16 | any | any\nDROP | any | 10.10.0.0/16 | any',
        hint: 'action | source | destination | service',
        help: 'Action ALLOW, DROP or REJECT. Source and destination: IPv4 or IPv6 CIDRs (comma separated) or any. Service: any, or tcp/443, udp/53, tcp/8000-8080. Evaluated top to bottom.',
        showWhen: { input: 'gateway_firewall', equals: ['true'] },
      },
    ],
    automation: (values                 , name        )             => {
      const ns = str(values, 'namespace', 'team-a');
      const pol = label(str(values, 'policy_name', 'policy'), 'policy');
      const applied = str(values, 'applied_to', 'app=web');
      const drop = bool(values, 'default_drop', true);
      const priority = num(values, 'priority', 10);
      void name;

      const findings            = [];
      const kv = (s        )                         => Object.fromEntries(listOf(s).map((p) => { const [k = '', v = ''] = p.split('='); return [k.trim(), v.trim()]; }));
      const appliedLabels = kv(applied);
      if (Object.keys(appliedLabels).length === 0) findings.push(error('vcfa91.sp.no-selector', 'The policy applies to no VMs.', { source: SRC }));

      const RULE_HELP = '[allow|drop|reject] from <label=value | CIDR> [to <label=value | CIDR>] <tcp|udp>/<port[-port]> | any';
      // A peer is a label selector (has =) or a CIDR of either family; an ipBlocks
      // cidr may be IPv6, one family per block.
      const peerOf = (text        , line        )                                                                   => {
        if (text.includes('=')) return { selector: true, value: text };
        const parsed = parseCidrAny(text);
        if (parsed === null || !text.includes('/')) {
          findings.push(warning('vcfa91.sp.rule', `Could not read "${line}": ${text} is neither label=value nor an IPv4 or IPv6 CIDR.`, { remediation: RULE_HELP, source: SRC }));
          return undefined;
        }
        return { selector: false, value: parsed.family === 6 ? `${parsed.network}/${parsed.prefix}` : text, family: parsed.family };
      };
      const rules = str(values, 'rules', '')
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .map((line, i) => {
          const m = /^(?:(allow|drop|reject)\s+)?from\s+(\S+)(?:\s+to\s+(\S+))?\s+(?:(tcp|udp)\/(\d{1,5}(?:-\d{1,5})?)|(any))$/i.exec(line);
          if (!m) {
            findings.push(warning('vcfa91.sp.rule', `Could not read "${line}".`, { remediation: RULE_HELP, source: SRC }));
            return undefined;
          }
          const [, act = 'allow', from = '', to, proto, portText, anyService] = m;
          const action = act.toLowerCase();
          const src = peerOf(from, line);
          const dst = to === undefined ? undefined : peerOf(to, line);
          if (!src || (to !== undefined && !dst)) return undefined;
          const ports = anyService ? undefined : portOf(portText ?? '');
          if (!anyService && !ports) {
            findings.push(warning('vcfa91.sp.rule', `Could not read "${line}": ${portText} is not a port or range.`, { remediation: RULE_HELP, source: SRC }));
            return undefined;
          }
          if (!src.selector && isAnyNetwork(from) && action === 'allow') findings.push(warning('vcfa91.sp.any', `Rule ${i + 1} allows ${anyService ? 'everything' : `${proto}/${portText}`} from anywhere${src.family === 6 ? ' on IPv6' : ''}.`, { source: SRC }));
          if (anyService && action === 'allow') findings.push(info('vcfa91.sp.any-service', `Rule ${i + 1} allows every port from ${from}.`, { source: SRC }));
          const svc = anyService ? 'any' : `${(proto ?? 'tcp').toLowerCase()}-${portText}`;
          return { name: `${action}-${svc}-${i + 1}`, action: action === 'allow' ? 'Allow' : action === 'drop' ? 'Drop' : 'Reject', src, dst, proto: (proto ?? 'tcp').toUpperCase(), ports };
        })
        .filter((r)                             => r !== undefined);
      if (!drop) findings.push(info('vcfa91.sp.no-drop', 'Without a drop rule the allows change nothing — everything else is still allowed by the default rule.', { source: SRC }));

      const policy             = {
        plural: 'securitypolicies',
        object: {
          apiVersion: 'crd.nsx.vmware.com/v1alpha1',
          kind: 'SecurityPolicy',
          metadata: { name: pol, namespace: ns },
          spec: {
            priority,
            appliedTo: [{ vmSelector: { matchLabels: appliedLabels } }],
            rules: [
              ...rules.map((r) => ({
                name: r.name,
                direction: 'In',
                action: r.action,
                sources: [r.src.selector ? { vmSelector: { matchLabels: kv(r.src.value) } } : { ipBlocks: [{ cidr: r.src.value }] }],
                ...(r.dst ? { destinations: [r.dst.selector ? { vmSelector: { matchLabels: kv(r.dst.value) } } : { ipBlocks: [{ cidr: r.dst.value }] }] } : {}),
                ...(r.ports ? { ports: [{ protocol: r.proto, port: r.ports.port, ...(r.ports.endPort ? { endPort: r.ports.endPort } : {}) }] } : {}),
              })),
              ...(drop ? [{ name: 'drop-other-inbound', direction: 'In', action: 'Drop' }] : []),
            ],
          },
        },
      };
      const yaml = k8sYaml([{ comment: ['VERIFY: kubectl explain securitypolicy.spec (crd.nsx.vmware.com). Field names follow the NSX operator v1alpha1 CRD.'], object: policy.object }]);
      const selector = Object.entries(appliedLabels).map(([k, v]) => `${k}=${v}`).join(',');
      // The scope, in the log before the policy exists: the VMs its selector matches.
      const policyPre = String.raw`var SELECTOR = ${JSON.stringify(selector)};
var vmList = kubeCall("GET", collectionPath("vmoperator.vmware.com/" + (settings.vmOperatorApi || "v1alpha5"), ${JSON.stringify(ns)}, "virtualmachines") + "?labelSelector=" + encodeURIComponent(SELECTOR), null, [404]);
if (vmList.statusCode === 404) System.warn("Could not list VMs with vmoperator.vmware.com/" + (settings.vmOperatorApi || "v1alpha5") + "; set vmOperatorApi to the version kubectl api-versions shows.");
else {
  var covered = [];
  for (var v = 0; v < ((vmList.body && vmList.body.items) || []).length; v++) covered.push(String(vmList.body.items[v].metadata.name));
  System.log("VMs the policy will cover (" + SELECTOR + "): " + (covered.length ? covered.join(", ") : "none yet"));
}`;
      const pkg = toPackage({
        packageName: packageNameOf('vcfa91', 'security', ns, pol),
        description: `Creates the vDefend security policy ${pol} for VMs in the All Apps namespace ${ns}.`,
        categoryPath: `${AREA}/Security policies/${ns}/${pol}`,
        workflow: {
          name: `Create security policy ${pol}`,
          description: `Lists the VMs labelled ${selector} in namespace ${ns} (the scope), then creates the NSX operator SecurityPolicy ${pol} through the namespace's Kubernetes API unless it exists — never changing one that does. With the dryRun input set to true it validates it on the server (dryRun=All) and creates nothing.`,
          inputs: [DRY_RUN_INPUT],
          outputs: KUBE_OUTPUTS,
          script: kubeWorkflow({ resource: 'policy.json', served: ['crd.nsx.vmware.com/v1alpha1'], pre: policyPre }),
        },
        config: kubeConfig(`Create security policy ${pol}`, '', 1, [{ name: 'vmOperatorApi', type: 'string', value: 'v1alpha5', description: 'The vmoperator.vmware.com version used to list the VMs the policy covers' }]),
        resources: [{ name: 'policy.json', content: json([policy]) }],
      });

      // The gateway firewall on the organization's transit gateway: NSX Policy API objects.
      const gw = bool(values, 'gateway_firewall', false);
      const project = label(str(values, 'nsx_project', 'default'), 'default');
      const tgw = label(str(values, 'tgw', 'default'), 'default');
      const projectBase = `/orgs/default/projects/${project}`;
      const gwObjects              = [];
      const gwRules                            = [];
      if (gw) {
        const groupOf = (cells        , line        )                       => {
          if (cells.toLowerCase() === 'any' || cells === '') return ['ANY'];
          const cidrs = listOf(cells);
          for (const c of cidrs) {
            if (c.includes('=')) {
              findings.push(error('vcfa91.sp.gw-label', `"${c}": gateway firewall rules match addresses; use CIDRs (labels are for the distributed firewall).`, { path: line, source: SRC }));
              return undefined;
            }
            if (parseCidrAny(c) === null || !c.includes('/')) {
              findings.push(error('vcfa91.sp.gw-cidr', `"${c}" is not an IPv4 or IPv6 CIDR.`, { path: line, source: SRC }));
              return undefined;
            }
          }
          const id = `gw-${cidrs.join('-').replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`.slice(0, 60).replace(/-+$/, '');
          const path = `${projectBase}/infra/domains/default/groups/${id}`;
          if (!gwObjects.some((o) => o.path === path)) {
            gwObjects.push({ label: `group ${cidrs.join(', ')}`, path, file: `nsx/group-${id}.json`, body: { display_name: id, expression: [{ resource_type: 'IPAddressExpression', ip_addresses: cidrs }] } });
          }
          return [path];
        };
        rowsOf(str(values, 'gateway_rules', '')).forEach(({ cells, line }, i) => {
          const [action = '', src = 'any', dst = 'any', service = 'any'] = cells;
          const act = action.toUpperCase();
          if (!['ALLOW', 'DROP', 'REJECT'].includes(act)) {
            findings.push(error('vcfa91.sp.gw-action', `"${action}" is not ALLOW, DROP or REJECT.`, { path: line, source: SRC }));
            return;
          }
          const s = groupOf(src, line);
          const d = groupOf(dst, line);
          if (!s || !d) return;
          const sm = /^(tcp|udp)\/(\S+)$/i.exec(service);
          const p = sm ? portOf(sm[2] ) : undefined;
          if (service.toLowerCase() !== 'any' && !p) {
            findings.push(error('vcfa91.sp.gw-service', `"${service}" is not "any" or proto/port.`, { path: line, source: SRC }));
            return;
          }
          if (act === 'ALLOW' && s[0] === 'ANY' && d[0] === 'ANY' && service.toLowerCase() === 'any') findings.push(warning('vcfa91.sp.gw-any', `Gateway rule ${i + 1} allows everything to everything.`, { path: line, source: SRC }));
          gwRules.push({
            id: `rule-${i + 1}`,
            display_name: `${act.toLowerCase()}-${i + 1}`,
            action: act,
            sequence_number: (i + 1) * 10,
            source_groups: s,
            destination_groups: d,
            services: ['ANY'],
            ...(sm && p ? { service_entries: [{ resource_type: 'L4PortSetServiceEntry', id: `svc-${i + 1}`, l4_protocol: sm[1] .toUpperCase(), destination_ports: [p.endPort ? `${p.port}-${p.endPort}` : String(p.port)] }] } : {}),
            scope: [`${projectBase}/transit-gateways/${tgw}`],
            direction: 'IN_OUT',
            logged: act !== 'ALLOW',
            disabled: false,
          });
        });
        if (gwRules.length === 0) findings.push(error('vcfa91.sp.gw-none', 'The gateway firewall has no rule.', { source: SRC }));
        gwObjects.push({ label: `gateway policy ${pol} on ${tgw}`, path: `${projectBase}/infra/domains/default/gateway-policies/${pol}`, file: `nsx/gateway-policy-${pol}.json`, body: { display_name: pol, category: 'LocalGatewayRules', sequence_number: priority, rules: gwRules } });
      }
      const gwScript = gw
        ? nsxScript({
            purpose: `Gateway firewall policy ${pol} on transit gateway ${tgw} of NSX project ${project}.`,
            body: [`nsx_get ${JSON.stringify(`${projectBase}/transit-gateways/${tgw}`)} >/dev/null || { echo "No transit gateway ${tgw} in project ${project} (VERIFY: GET /policy/api/v1${projectBase}/transit-gateways)" >&2; exit 1; }`, ...nsxEnsureLines(gwObjects)],
            undo: `DELETE /policy/api/v1${projectBase}/infra/domains/default/gateway-policies/${pol}, then the groups: traffic through ${tgw} falls back to its default rule.`,
          })
        : '';

      return {
        platform: PLATFORM,
        title: `Firewall policy ${pol} in ${ns}${gw ? `, and gateway firewall on ${tgw}` : ''}`,
        effect: 'reversible',
        trigger: { kind: 'manual', detail: 'The application team, when the VMs are created or a flow changes.' },
        scope: {
          what: `VMs in ${ns} labelled ${applied}: inbound ${rules.map((r) => `${r.action.toLowerCase()} ${r.ports ? `${r.proto}/${r.ports.port}${r.ports.endPort ? `-${r.ports.endPort}` : ''}` : 'any'}`).join(', ') || 'nothing'}${drop ? ', everything else dropped' : ''}${gw ? `; and ${gwRules.length} gateway rule(s) on transit gateway ${tgw}` : ''}.`,
          decidedBy: ['The label selector — every VM that has, or later gets, those labels.', 'The namespace; the policy cannot reach VMs in another.', 'Priority against other policies in the namespace and the organization.'],
          ifWrong: 'A selector that matches more than meant drops traffic to VMs nobody considered; one that matches nothing leaves them open.',
        },
        guardrails: [
          { rule: 'Stops unless the current context is EXPECT_CONTEXT', because: 'The context is the scope.' },
          { rule: 'Server-side dry run before creating, and create rather than apply', because: 'The NSX operator validates selectors and ports; create refuses to overwrite a policy another team maintains.' },
          ...(gw ? [{ rule: 'The gateway policy and its groups are created only when nothing is at their paths', because: 'A gateway policy someone tuned in the portal is not overwritten; change it there, or delete it and run again.' }] : []),
        ],
        dryRun: ['Run the workflow with the dryRun input set to true to preview: it logs the VMs the selector matches and sends the policy with dryRun=All, creating nothing.', 'scripts/create-policy.sh --dry-run runs a server-side dry run.', 'Before the first real run, kubectl get vm -n ' + ns + ' -l ' + applied.replace(/\s/g, '') + ' shows which VMs it will cover.'],
        undo: [`kubectl delete securitypolicy ${pol} -n ${ns} — traffic falls back to the default rule immediately.`],
        told: ['NSX Manager audit log, and the DFW rule hit counts in VCF Operations for Networks.', 'The workflow log (the VMs covered, AUDIT lines), its summary output and the webhook when set.'],
        requires: ['vDefend firewall delegated to the organization by the provider (9.1).', 'VMs carrying the labels.'],
        files: {
          ...pkg.files,
          [`${pol}.k8s.yaml`]: yaml,
          'scripts/create-policy.sh': kubeScript(`Create security policy ${pol} in ${ns}.`, [`echo "VMs it will cover:"; kubectl get vm -n ${q(ns)} -l ${q(Object.entries(appliedLabels).map(([k, v]) => `${k}=${v}`).join(','))} || true`], [`${pol}.k8s.yaml`], `kubectl delete securitypolicy ${pol} -n ${ns}`),
          ...(gw ? { ...Object.fromEntries(gwObjects.map((o) => [o.file, json(o.body)])), 'scripts/apply-gateway-firewall.sh': gwScript } : {}),
          'IMPORT.md': importMd({
            subject: `The vDefend security policy ${pol} in ${ns}: an Orchestrator workflow that creates it through the namespace's Kubernetes API, and the same object as ${pol}.k8s.yaml for kubectl.`,
            orgs: ALL_APPS,
            steps: [
              ...pkg.importSteps,
              kubeStep('Or: the policy with kubectl', 'scripts/create-policy.sh', [`${pol}.k8s.yaml`], ['The script first lists the VMs the policy’s selector matches: that list is the scope.']),
              ...(gw ? [manualStep(`The gateway firewall on ${tgw}`, ['`NSX_HOST=… NSX_USER=… NSX_PASSWORD_FILE=… ./scripts/apply-gateway-firewall.sh` creates the CIDR groups and the gateway policy unless they exist; `--dry-run` only reads. An organization administrator with gateway firewall delegated does the same in the organization portal: Networking → Transit Gateways → Gateway Firewall.'])] : []),
            ],
            auth: ['kube', 'vcfa91'],
            verify: [
              'The SecurityPolicy apiVersion and resource name (crd.nsx.vmware.com/v1alpha1, securitypolicies): kubectl api-resources | grep -i securitypolic. The workflow stops before sending anything if the group is not served.',
              KUBE_VERIFY,
              'Rule actions Allow, Drop and Reject, destinations, and ports with endPort follow the NSX operator SecurityPolicy CRD; VERIFY with kubectl explain securitypolicy.spec.rules.',
              ...(gw ? ['VERIFY: the gateway policy path /orgs/default/projects/<project>/infra/domains/default/gateway-policies, category LocalGatewayRules and the rule scope of a transit gateway path (NSX 9 multi-tenancy).'] : []),
            ],
          }),
        },
        notes: [
          '9.1 what’s new: providers can delegate vDefend Distributed and Gateway Firewall to organization administrators, with RBAC labels for dynamic groups.',
          ...(rules.some((r) => !r.src.selector && r.src.value.includes(':')) || rules.some((r) => r.dst !== undefined && !r.dst.selector && r.dst.value.includes(':'))
            ? ['IPv6 sources are written as their own ipBlocks entries (cidr: 2001:db8::/32), one family per rule; the distributed firewall matches IPv6 as well as IPv4. VERIFY: kubectl explain securitypolicy.spec.rules.sources.ipBlocks accepts an IPv6 cidr on your NSX operator.']
            : []),
        ],
        findings,
      };
    },
  }),

  // -------------------------------------------------------------------------
  automationBlueprint({
    id: 'vcfa91_estate_check',
    platform: PLATFORM,
    label: 'A daily health check of VCF Automation 9.1 from the provider side',
    group: 'VCF Automation 9.1 — provider',
    description:
      'One read-only script a scheduler can run daily: the API version is offered, every organization is enabled, regions, region quotas and content libraries are READY, and no API token of the provider account expires soon. Exit 1 on anything worth a look; a path that moved is reported, not ignored.',
    inputs: [
      { id: 'expiry_warn_days', label: 'Token expiry warning (days)', control: 'number', default: 14, min: 1, max: 365 },
      { id: 'schedule', label: 'Run daily at 06:30', control: 'toggle', default: true },
    ],
    automation: (values                 , name        )             => {
      const warn = num(values, 'expiry_warn_days', 14);
      const schedule = bool(values, 'schedule', true);
      void name;
      const script = restScript({
        purpose: 'Daily provider-side health check of VCF Automation 9.1.',
        scope: 'provider',
        act: false,
        checkVersion: true,
        body: [
          `WARN_DAYS=${warn}`,
          'PROBLEMS=0',
          'note() { echo "  ! $*"; PROBLEMS=$((PROBLEMS+1)); }',
          '',
          'echo "Organizations:"',
          "if O=$(probe '/cloudapi/1.0.0/orgs?pageSize=128'); then",
          "  jq -r '.values[] | \"  \\(.name)\\tenabled=\\(.isEnabled)\\tclassic=\\(.isClassicTenant // \"?\")\"' <<<\"$O\"",
          "  for o in $(jq -r '.values[] | select(.isEnabled == false) | .name' <<<\"$O\"); do note \"organization $o is disabled\"; done",
          'else PROBLEMS=$((PROBLEMS+1)); fi',
          '',
          'echo "Regions:"',
          "if R=$(probe '/cloudapi/vcf/regions?pageSize=128'); then",
          "  for r in $(jq -r '.values[] | select(.status != \"READY\") | \"\\(.name)=\\(.status)\"' <<<\"$R\"); do note \"region $r\"; done",
          "  echo \"  $(jq '.values | length' <<<\"$R\") region(s)\"",
          'else PROBLEMS=$((PROBLEMS+1)); fi',
          '',
          'echo "Region quotas:"',
          "if Q=$(probe '/cloudapi/vcf/virtualDatacenters?pageSize=128'); then",
          "  for q in $(jq -r '.values[] | select((.status // \"READY\") != \"READY\") | \"\\(.name)=\\(.status)\"' <<<\"$Q\"); do note \"quota $q\"; done",
          'else PROBLEMS=$((PROBLEMS+1)); fi',
          '',
          'echo "Content libraries:"',
          "if L=$(probe '/cloudapi/vcf/contentLibraries?pageSize=128'); then",
          "  for l in $(jq -r '.values[] | select((.status // \"READY\") != \"READY\") | \"\\(.name)=\\(.status)\"' <<<\"$L\"); do note \"library $l (subscribed library 401s are a 9.1.1 known issue)\"; done",
          'else PROBLEMS=$((PROBLEMS+1)); fi',
          '',
          'echo "API tokens of this account:"',
          "if T=$(probe '/cloudapi/1.0.0/tokens?filter=type==REFRESH&pageSize=128'); then",
          '  NOW=$(date +%s)',
          "  for t in $(jq -r --argjson now \"$NOW\" --argjson w \"$WARN_DAYS\" '.values[]? | select(.expirationDate != null) | select(((.expirationDate | sub(\"\\\\.[0-9]+\"; \"\") | sub(\"(?<z>[+-][0-9]{2}:[0-9]{2}|Z)$\"; \"Z\") | fromdateiso8601) - $now) < ($w * 86400)) | .name' <<<\"$T\"); do note \"token $t expires within ${WARN_DAYS} days\"; done",
          'else PROBLEMS=$((PROBLEMS+1)); fi',
          '',
          'echo; (( PROBLEMS == 0 )) && echo "All checks passed." || echo "${PROBLEMS} problem(s)."',
          'exit $(( PROBLEMS > 0 ? 1 : 0 ))',
        ],
      });

      const pkg = toPackage({
        packageName: packageNameOf('vcfa91', 'health'),
        description: 'A daily provider-side health check of VCF Automation 9.1: organizations, regions, region quotas, content libraries and the provider account\'s API tokens. Reads only.',
        categoryPath: `${AREA}/Health`,
        workflow: {
          name: 'VCF Automation health check',
          description: `Reads, as the provider: the API version is offered, every organization is enabled, regions, region quotas and content libraries are READY, and no API token of the account expires within ${warn} days. Fails the run on anything worth a look, so a schedule alerts; a path that answers 404 is a problem, not a pass.`,
          inputs: [],
          outputs: [
            { name: 'problemCount', type: 'number', description: 'Things worth a look' },
            { name: 'summary', type: 'string', description: 'The audit record, JSON' },
          ],
          script: estateWorkflow(),
        },
        config: {
          name: 'Settings',
          description: 'Settings of the health check. Fill vcfaApiToken (a provider API token for a read-only provider role) after import.',
          attributes: [VCFA_HOST_ATTR, TOKEN_ATTR('a read-only provider account'), API_VERSION_ATTR, { name: 'expiryWarnDays', type: 'number', value: warn, description: 'Flag API tokens expiring within this many days' }, WEBHOOK_ATTR],
        },
      });

      return {
        platform: PLATFORM,
        title: 'VCF Automation 9.1 provider health check',
        effect: 'read',
        trigger: { kind: schedule ? 'schedule' : 'manual', detail: schedule ? 'Daily at 06:30 from cron; the scheduler alerts on exit 1.' : 'Run by hand.' },
        scope: {
          what: 'Every organization, region, region quota and content library the provider account can see, and that account’s own API tokens. Read only.',
          decidedBy: ['The provider token’s rights — a read-only provider role is enough and is what it should be given.'],
          ifWrong: 'Nothing changes; a too-narrow token under-reports, which is why a probe that fails counts as a problem.',
        },
        guardrails: [],
        dryRun: ['It only reads.'],
        undo: ['Nothing to undo.'],
        told: ['The workflow log (PROBLEM warnings), its summary output and the webhook when set; a run with problems fails, which is what a schedule alerts on.', schedule ? 'The cron log and whatever alerts on the exit code.' : 'The terminal.'],
        requires: ['A provider API token for a read-only provider role: in the configuration element (Orchestrator) or a mode-600 file (script).', 'Orchestrator in VCF Automation 9.1 with the VCF Automation certificate trusted; or curl and jq for the script.'],
        files: {
          ...pkg.files,
          'IMPORT.md': importMd({
            subject: 'A daily provider-side health check, as an Orchestrator workflow (schedule it daily) or a script for cron. It reads; nothing is imported into VCF Automation itself.',
            orgs: PROVIDER,
            steps: [
              ...pkg.importSteps,
              checkStep('vcfa-health.sh', 'organizations, regions, quotas, content libraries and API tokens (what-it-checks.txt).'),
              ...(schedule ? [manualStep('Schedule the script', ['crontab.txt holds the line, with no secret in it: the script reads the provider API token from the file it names.'])] : []),
            ],
            auth: ['vcfa91'],
            verify: [
              'Paths follow the go-vcloud-director v3 SDK: /cloudapi/1.0.0/orgs and /cloudapi/1.0.0/tokens; /cloudapi/vcf/regions, /cloudapi/vcf/virtualDatacenters (region quotas — earlier versions of this kit read /cloudapi/1.0.0/virtualDatacenters) and /cloudapi/vcf/contentLibraries. A path that answers anything but 200 is reported and counted.',
              'VERIFY: the tokens list (type==REFRESH filter, expirationDate field) is the Cloud Director token API as inherited.',
            ],
          }),
          'scripts/vcfa-health.sh': script,
          ...(schedule ? { 'crontab.txt': cronLine('30 6 * * *', 'VCFA_HOST=vcfa.example.com VCFA_API_TOKEN_FILE=/etc/vcf-automation/vcfa-provider-api-token', 'vcfa-health.sh', 'vcfa-health.log') } : {}),
          'what-it-checks.txt': [
            'GET /api/versions                       the API version the scripts use is offered',
            'GET /cloudapi/1.0.0/orgs                every organization enabled',
            'GET /cloudapi/vcf/regions               every region READY            (VERIFY path)',
            'GET /cloudapi/vcf/virtualDatacenters    every region quota READY      (SDK path)',
            'GET /cloudapi/vcf/contentLibraries      every library READY           (VERIFY path)',
            'GET /cloudapi/1.0.0/tokens              no own API token expiring soon (VERIFY path)',
            '',
            'A path that answers anything but 200 is printed as VERIFY and counted as a problem,',
            'so a moved API shows up the first morning rather than as a silent pass.',
            '',
          ].join('\n'),
        },
        notes: [
          '9.1.1 deprecates public cloud (AWS, Azure, GCP) resource management in VCF Automation and disables it by default. VM Apps organizations that still have public cloud accounts should be listed from each organization (GET /iaas/api/cloud-accounts) before upgrading.',
          'Paths under /cloudapi/vcf/ are inferred from the Go SDK the Terraform provider is built on.',
        ],
        findings: [],
      };
    },
  }),
];

// ---------------------------------------------------------------------------
// The blueprints in the helper modules, built on the same building blocks.

const KIT            = {
  PLATFORM,
  SRC,
  ALL_APPS,
  PROVIDER,
  AREA,
  LABEL,
  VERSIONS_TF,
  KUBE_VERIFY,
  KUBE_OUTPUTS,
  DRY_RUN_INPUT,
  LOGIN_JS,
  CLOUDAPI_JS,
  CLOUD_LOGIN_JS,
  VCFA_HOST_ATTR,
  TOKEN_ATTR,
  ORG_ATTR,
  API_VERSION_ATTR,
  GUARD_ATTRS,
  WEBHOOK_ATTR,
  label,
  q,
  json,
  restScript,
  kubeScript,
  kubeReadScript,
  tfScript,
  k8sYaml,
  kubeWorkflow,
  kubeConfig,
  tfStep,
  checkStep,
};

export const VCF_AUTOMATION_91                                 = [...CORE_91, ...vcfa91Govern(KIT), ...vcfa91Network(KIT)];
