/**
 * VCF Operations 9.1: building the content people look at, and the things it
 * is extended with.
 *
 * The other VCF Operations blueprints write what an automation stands on — the
 * alert, the policy, the schedule. This set writes what a person opens: the
 * dashboard, the view behind it, the report built from the views. And the
 * three ways VCF Operations is extended in 9.1: a management pack someone else
 * wrote, one built in Management Pack Builder (which now reads Prometheus), and
 * the orchestrator's Python and PowerShell workflows.
 *
 * Dashboards come out in the same JSON the Aria Ops page reads — a
 * `dashboards` array, widgets placed by `gridsterCoords` on a 12-column grid —
 * so a dashboard written here can be dropped back onto that page and checked
 * like any other.
 *
 * The second export is VCF Operations for Networks 9.1: VPC planning, the
 * migration-wave generator, the assessment report and the admin health view.
 */

import { bool, num, str,                      } from '../../kit/blueprint.js';
import { error, info, warning,              } from '../../core/findings.js';
import { automationBlueprint,                          } from '../from-automation.js';
import { listOf, slugOf,                 } from '../automation.js';
import { authHeader, authPreamble, readScript } from '../apply.js';
import { networksPreamble, networksScheduledEnv } from './vcf-networks-logs.js';
import { authFileVar, workDirLines } from './vcf-operations-content.js';
import { CSV_COLUMNS } from '../../migration/portfolio.js';
import { packageNameOf, toPackage,                        } from '../vro/to-package.js';
                                                   
                                                      
import {
  CONTENT_ZIP,
  DASHBOARD_OWNER_PLACEHOLDER,
  FORMAT_SOURCES,
  contentImportScript,
  contentPackage,
  contentStep,
  importMd,
  nothingToImportMd,
  stableId,
} from '../vcfops-import.js';

const PLATFORM = 'vcf-operations'         ;
const NETWORKS = 'vcf-operations-networks'         ;
const SRC = 'ArchToolKit';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * A header for a token that is not one of the apply.ts targets (the
 * orchestrator's Bearer, HCX's x-hm-authorization, the Networks token), written
 * the way authPreamble writes its own: a file only this user can read, removed
 * on exit, and passed to curl as -H @file so the token is never an argument.
 * The trap also removes the VCF Operations header file, in case the script has
 * one: a second trap on EXIT replaces the first.
 */
function privateHeader(fileVar        , prefix        , tokenVar        )           {
  return [
    `${fileVar}="$(umask 077; mktemp "\${TMPDIR:-/tmp}/atk-auth.XXXXXX")"`,
    `trap 'rm -f "$${fileVar}" "\${${authFileVar(PLATFORM)}:-}"' EXIT`,
    `printf '%s %s\n' '${prefix}' "$${tokenVar}" > "$${fileVar}"`,
  ];
}

/** Escape for a bash single-quoted string. */
function sq(text        )         {
  return text.replace(/'/g, "'\\''");
}

function xml(text        )         {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function csvCell(value                 )         {
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Name-derived ids (see vcfops-import.ts), re-exported for the blueprints that already use them from here. */
export { stableId };

const viewIdOf = (name        )         => stableId(`view:${name}`);

const CONTENT_IMPORT_NOTE =
  'Content import: POST /suite-api/api/content/operations/import (multipart contentFile) answers 202 with the new operation’s id; GET on the same path is the last import, with state NOT_INITIALIZED, INITIALIZED, RUNNING, FAILED, FINISHED or UNKNOWN and operationSummaries[] (imported, skipped, failed). The reference says "If the force option is set to true, content will be overwritten. By default the flag is true", so the script sends force=false unless --overwrite. The importer checks for the instance’s own <number>L.v1 marker file, which the script copies from the backup export it takes first.';

// ---------------------------------------------------------------------------
// Orchestrator packages: what the automations here share
// ---------------------------------------------------------------------------

const ap = (name        , type        , description        ) => ({ name, type, description });

/** The package's import steps first, in the shape importMd takes. */
function packageSteps(pkg                   , what        )               {
  return pkg.importSteps.map((step, index) => ({
    heading: index === 0 ? `${step.heading} — the workflow that ${what}` : step.heading,
    files: index === 0 ? [pkg.packageDir, 'import/com.archtoolkit.core.package'] : [],
    how: step.lines.filter((line) => line.trim() !== '').map((line) => line.replace(/^- /, '')),
  }));
}

/** The VCF Operations account every VCF Operations package here logs in with. */
const OPS_ATTRIBUTES = [
  { name: 'opsHost', type: 'string', value: '', description: 'VCF Operations host (FQDN)' },
  { name: 'opsUsername', type: 'string', value: '', description: 'The account the workflow logs in as' },
  { name: 'opsPassword', type: 'SecureString', description: 'Its password' },
  { name: 'opsAuthSource', type: 'string', value: '', description: 'Authentication source for the account; empty for a local account' },
]         ;

const NET_ATTRIBUTES = [
  { name: 'netHost', type: 'string', value: '', description: 'VCF Operations for Networks platform host (FQDN)' },
  { name: 'netUsername', type: 'string', value: '', description: 'A read-only account' },
  { name: 'netPassword', type: 'SecureString', description: 'Its password' },
  { name: 'netDomainType', type: 'string', value: 'LOCAL', description: 'LOCAL for a local account, LDAP for a directory account' },
  { name: 'netDomain', type: 'string', value: 'local', description: 'local, or the directory domain' },
]         ;

/**
 * ASCII-only text for the content zip. The Orchestrator REST plugin sends a
 * request body as a string, so the content zip is built so that every byte of
 * it is below 0x80 (see zipStored); characters above that are written as the
 * escape their format reads back as the same character.
 */
const ASCII_ACTION               = {
  name: 'ascii',
  description: 'The text with every character above 0x7F written as an escape its format reads back as the same character: \\uXXXX in JSON (such characters only occur inside JSON strings), &#N; in XML.',
  resultType: 'string',
  params: [ap('text', 'string', 'The text'), ap('kind', 'string', 'json or xml')],
  script: String.raw`var s = text === null || text === undefined ? "" : String(text);
var out = "";
for (var i = 0; i < s.length; i++) {
  var c = s.charCodeAt(i);
  if (c < 128) { out += s.charAt(i); continue; }
  if (String(kind) === "json") {
    var h = c.toString(16);
    out += "\\u" + "0000".substring(h.length) + h;
    continue;
  }
  if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
    var low = s.charCodeAt(i + 1);
    if (low >= 0xdc00 && low <= 0xdfff) { c = (c - 0xd800) * 1024 + (low - 0xdc00) + 0x10000; i++; }
  }
  out += "&#" + c + ";";
}
return out;`,
};

/**
 * A zip of stored (uncompressed) entries, as a string of byte values.
 *
 * Why this shape: the only public way into VCF Operations for a dashboard, a
 * view or a report definition is Content Management import, a multipart zip
 * upload; the Orchestrator REST plugin sends a request body as a string and is
 * known to mangle binary (kuklis.github.io, "Downloading and uploading binary
 * files with VCF Orchestrator"). So every number in the zip — CRC-32, sizes,
 * offsets, counts — is made to have no byte above 0x7F: an entry allowed to
 * grow ("text": trailing spaces; "zip": a nested zip's own comment) is padded
 * until its CRC and size are, offsets are moved with an extra field (id "AT",
 * which readers skip), and the central directory size with the last entry's
 * comment. Only an entry with pad "none" (the instance marker) can keep a CRC
 * byte above 0x7F; the upload declares charset=ISO-8859-1 for that case.
 */
const ZIP_ACTION               = {
  name: 'zipStored',
  description:
    'A zip of stored entries as a string of byte values (0-255), with every CRC, size and offset free of bytes above 0x7F so the zip survives the REST plugin as text. entries: [{ name, data, pad }]; pad "text" may append spaces, "zip" may lengthen a nested zipStored result\'s comment, "none" keeps the data exactly. Data must already be bytes (ascii() first).',
  resultType: 'string',
  params: [ap('entries', 'Any', 'Array of { name, data, pad }')],
  script: String.raw`if (!entries || !entries.length) throw new Error("zipStored: no entries");
if (entries.length > 127) throw new Error("zipStored: at most 127 entries");
var TABLE = [];
for (var n = 0; n < 256; n++) {
  var c = n;
  for (var b = 0; b < 8; b++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  TABLE.push(c >>> 0);
}
function feed(reg, text) {
  for (var i = 0; i < text.length; i++) reg = TABLE[(reg ^ text.charCodeAt(i)) & 255] ^ (reg >>> 8);
  return reg;
}
function done(reg) { return (reg ^ 0xffffffff) >>> 0; }
function safe32(v) { return (v & 0x80808080) === 0; }
function safe16(v) { return v >= 0 && v <= 0xffff && (v & 0x8080) === 0; }
function le16(v) { return String.fromCharCode(v & 255, (v >>> 8) & 255); }
function le32(v) { return String.fromCharCode(v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255); }
function spaces(k) { var s = ""; for (var i = 0; i < k; i++) s += " "; return s; }
function fit(data, pad) {
  var k;
  if (pad === "text") {
    var reg = feed(0xffffffff, data);
    for (k = 0; k <= 65536; k++) {
      if (safe32(done(reg)) && safe32(data.length + k)) return { data: data + spaces(k), crc: done(reg) };
      reg = TABLE[(reg ^ 32) & 255] ^ (reg >>> 8);
    }
    throw new Error("zipStored: no padding makes this entry ASCII-safe");
  }
  if (pad === "zip") {
    if (data.length < 22 || data.substring(data.length - 2) !== "\u0000\u0000") throw new Error("zipStored: a nested zip must end with an empty comment");
    var base = data.substring(0, data.length - 2);
    var head = feed(0xffffffff, base);
    for (k = 0; k <= 4096; k++) {
      if (!safe16(k)) continue;
      var tail = le16(k) + spaces(k);
      var crc = done(feed(head, tail));
      if (safe32(crc) && safe32(base.length + tail.length)) return { data: base + tail, crc: crc };
    }
    throw new Error("zipStored: no comment length makes the nested zip ASCII-safe");
  }
  return { data: data, crc: done(feed(0xffffffff, data)) };
}
var out = "";
var heads = [];
for (var e = 0; e < entries.length; e++) {
  var name = String(entries[e].name);
  var raw = entries[e].data === null || entries[e].data === undefined ? "" : String(entries[e].data);
  if (!/^[\x21-\x7e][\x20-\x7e]*$/.test(name)) throw new Error("zipStored: an entry name must be printable ASCII: " + name);
  for (var q = 0; q < raw.length; q++) {
    if (raw.charCodeAt(q) > 255) throw new Error("zipStored: " + name + " has a character above 0xFF; pass it through ascii() first");
  }
  var fitted = fit(raw, String(entries[e].pad || "none"));
  var size = fitted.data.length;
  var offset = out.length;
  var fixed = 30 + name.length + size;
  var extra = "";
  if (!safe32(offset + fixed)) {
    var x = 4;
    while (x < 0x7f7f && !(safe16(x) && safe16(x - 4) && safe32(offset + fixed + x))) x++;
    if (x >= 0x7f7f) throw new Error("zipStored: cannot place " + name + " at an ASCII-safe offset");
    extra = le16(0x5441) + le16(x - 4) + spaces(x - 4);
  }
  out += "PK\u0003\u0004" + le16(20) + le16(0) + le16(0) + le16(0) + le16(0x21) + le32(fitted.crc) + le32(size) + le32(size) + le16(name.length) + le16(extra.length) + name + extra + fitted.data;
  heads.push({ name: name, crc: fitted.crc, size: size, offset: offset });
}
function central(h, comment) {
  return "PK\u0001\u0002" + le16(20) + le16(20) + le16(0) + le16(0) + le16(0) + le16(0x21) + le32(h.crc) + le32(h.size) + le32(h.size) + le16(h.name.length) + le16(0) + le16(comment) + le16(0) + le16(0) + le32(0) + le32(h.offset) + h.name + spaces(comment);
}
var cdOffset = out.length;
var cd = "";
for (var j = 0; j < heads.length - 1; j++) cd += central(heads[j], 0);
var last = heads[heads.length - 1];
var pad = 0;
while (pad < 0x7f7f && !(safe16(pad) && safe32(cd.length + 46 + last.name.length + pad))) pad++;
cd += central(last, pad);
return out + cd + "PK\u0005\u0006" + le16(0) + le16(0) + le16(heads.length) + le16(heads.length) + le32(cd.length) + le32(cdOffset) + le16(0);`,
};

/**
 * Content Management import from Orchestrator, as import-content.sh does it
 * and as sentania-labs/vcf-content-factory-bundles install.py does it on VCF
 * Operations 9: export the same content type (the backup, and the source of
 * the instance's "<number>L.v1" marker — the importer rejects a package whose
 * marker is not the instance's own; install.py writes the importing user's id
 * into it), build the package with the marker, POST it as multipart
 * contentFile to /content/operations/import?force=, and follow the import by
 * the id the POST returned. force=false (unless overwrite) skips content that
 * is already there, which is what makes a second run leave it alone.
 */
function contentImportAction(module        )               {
  return {
    name: 'contentImport',
    description:
      'Import content through VCF Operations Content Management, guarded by core.act. Reads first (current user, no import running) also in a dry run; the change is one act: export spec.contentType (backup + instance marker), build the package from spec.build(ownerId, userName).entries with the marker, POST /suite-api/api/content/operations/import?force=<spec.overwrite>, follow it by id. Returns { id, imported, skipped, marker } or null in a dry run; throws on FAILED, on failed items, or when nothing was imported or skipped.',
    resultType: 'Any',
    params: [
      ap('ctx', 'Any', 'What core.begin returned'),
      ap('host', 'string', 'VCF Operations host'),
      ap('auth', 'Any', 'What core.loginVcfOps returned'),
      ap('redact', 'Any', 'settings._secrets'),
      ap('spec', 'Any', '{ contentType, what, overwrite, build: function (ownerId, userName) returning { entries } }'),
    ],
    script: String.raw`var core = System.getModule("com.archtoolkit.core");
var own = System.getModule(${JSON.stringify(module)});
var SAFE = { redact: redact || [] };
function withSafe(extra) { var o = { redact: SAFE.redact }; for (var k in extra) if (extra.hasOwnProperty(k)) o[k] = extra[k]; return o; }
var base = "https://" + host + "/suite-api/api";
var api = base + "/content/operations";
var me = core.http("GET", base + "/auth/currentuser", auth, null, SAFE).body || {};
var ownerId = me.id ? String(me.id) : "";
var userName = String(me.username || me.userName || me.name || "");
if (!ownerId) throw new Error("GET /suite-api/api/auth/currentuser returned no id (VERIFY the call on your release): the content import files content under that user.");
var last = core.http("GET", api + "/import", auth, null, withSafe({ allow: [404] }));
var running = last.statusCode === 200 && last.body ? String(last.body.state || "") : "";
if (running === "INITIALIZED" || running === "RUNNING") throw new Error("Another content import is " + running + "; its status would be read as this one's. Wait for it to finish.");
var entries = spec.build(ownerId, userName).entries;
for (var i = 0; i < entries.length; i++) {
  if (/<REQUIRED|&lt;REQUIRED/.test(String(entries[i].data))) throw new Error(entries[i].name + " still holds a <REQUIRED> value. Fill it in the resource element first; an import with a placeholder shows an empty widget or column.");
  System.log("package entry: " + entries[i].name + " (" + String(entries[i].data).length + " bytes before padding)");
}
var force = spec.overwrite === true || String(spec.overwrite) === "true";
return core.act(ctx, "import " + spec.what + " through Content Management (force=" + force + ")", function () {
  var prev = core.http("GET", api + "/export", auth, null, withSafe({ allow: [404] }));
  var prevId = prev.statusCode === 200 && prev.body ? String(prev.body.id || "") : "";
  var prevStart = prev.statusCode === 200 && prev.body ? Number(prev.body.startTime || 0) : 0;
  core.http("POST", api + "/export", auth, { scope: "CUSTOM", contentTypes: [String(spec.contentType)] }, SAFE);
  var state = "";
  for (var t = 0; t < 60; t++) {
    System.sleep(5000);
    var e = core.http("GET", api + "/export", auth, null, withSafe({ allow: [404] }));
    if (e.statusCode !== 200 || !e.body) continue;
    var fresh = (e.body.id && String(e.body.id) !== prevId) || Number(e.body.startTime || 0) > prevStart;
    if (!fresh) continue;
    state = String(e.body.state || "");
    if (state === "FINISHED" || state === "FAILED") break;
  }
  if (state !== "FINISHED") throw new Error("The " + spec.contentType + " export did not finish (" + (state || "no status for it after 5 minutes") + "); nothing was imported.");
  System.log("Backup: the " + spec.contentType + " export just made is the latest export in Content Management (GET /suite-api/api/content/operations/export/zip) until the next one.");
  var exported = core.http("GET", api + "/export/zip", auth, null, withSafe({ accept: "application/zip" }));
  var marker = /([0-9]+L\.v1)/.exec(exported.text);
  if (!marker) throw new Error("The export has no <number>L.v1 marker file; the import would be rejected. VERIFY the export on your release.");
  System.log("Instance marker: " + marker[1]);
  var all = [{ name: marker[1], data: ownerId, pad: "none" }];
  for (var j = 0; j < entries.length; j++) all.push(entries[j]);
  var zip = own.zipStored(all);
  var boundary = "ArchToolKit-content-" + zip.length;
  while (zip.indexOf(boundary) >= 0) boundary += "x";
  var body = "--" + boundary + "\r\n" + "Content-Disposition: form-data; name=\"contentFile\"; filename=\"content.zip\"\r\n" + "Content-Type: application/zip\r\n\r\n" + zip + "\r\n--" + boundary + "--\r\n";
  var r = core.http("POST", api + "/import?force=" + force, auth, body, withSafe({ contentType: "multipart/form-data; boundary=" + boundary + "; charset=ISO-8859-1" }));
  var id = r.body && r.body.id ? String(r.body.id) : "";
  if (!id) throw new Error("The import was accepted without an id, so its result cannot be told from an earlier import. Check Content Management in the interface.");
  System.log("import " + id + " (force=" + force + ")");
  var status = null;
  for (var u = 0; u < 60; u++) {
    System.sleep(10000);
    var s = core.http("GET", api + "/import", auth, null, withSafe({ allow: [404] }));
    if (s.statusCode !== 200 || !s.body || String(s.body.id || "") !== id) continue;
    var st = String(s.body.state || "");
    System.log("import " + id + ": " + st);
    if (st === "FINISHED" || st === "FAILED") { status = s.body; break; }
  }
  if (!status) throw new Error("Import " + id + " did not finish in 10 minutes. Check Content Management in the interface.");
  var imported = 0, skipped = 0, failed = 0;
  var sums = status.operationSummaries || [];
  for (var v = 0; v < sums.length; v++) {
    imported += Number(sums[v].imported || 0);
    skipped += Number(sums[v].skipped || 0);
    failed += Number(sums[v].failed || 0);
  }
  var errors = (status.errorMessages || []).length;
  if (String(status.state) === "FAILED" || failed > 0 || errors > 0) throw new Error("Import " + id + " " + status.state + " with " + failed + " failed item(s) and " + errors + " error message(s).");
  if (imported === 0 && skipped === 0) throw new Error("Import " + id + " finished but reports nothing imported or skipped. VERIFY operationSummaries on your release, and check in the interface.");
  return { id: id, imported: imported, skipped: skipped, marker: marker[1] };
});`,
  };
}

/** The three actions a content-importing package carries. */
const contentActions = (module        )                 => [ASCII_ACTION, ZIP_ACTION, contentImportAction(module)];

/** The attributes of a content-importing package. */
function contentAttributes(cap        , extra                                                                                                                                                                                   = []) {
  return [
    ...OPS_ATTRIBUTES,
    { name: 'overwrite', type: 'boolean'         , value: false, description: 'false: content already there is skipped (force=false) and left as it is. true: it is replaced (force=true); the export the run takes first is the backup' },
    ...extra,
    { name: 'dryRun', type: 'boolean'         , value: true, description: 'The arming switch: nothing is imported while this is true' },
    { name: 'cap', type: 'number'         , value: cap, description: 'The most changes one run may make' },
    { name: 'webhook', type: 'SecureString'         , description: 'Optional: where the audit record is posted' },
  ];
}

/** The lines every VCF Operations workflow here starts with: checks, guard, login. */
const OPS_LOGIN = String.raw`if (!settings.opsHost) throw new Error("Set opsHost in the configuration element " + SETTINGS_NAME + ".");
if (!settings.opsUsername || !settings.opsPassword) throw new Error("Set opsUsername and opsPassword in the configuration element " + SETTINGS_NAME + ".");
var SAFE = { redact: settings._secrets };
var auth = core.loginVcfOps(settings.opsHost, settings.opsUsername, settings.opsPassword, settings.opsAuthSource || "");`;

/**
 * The content workflow: one import, then the audit. build is the body of
 * function (ownerId, userName) returning { entries }.
 */
function contentWorkflow(contentType        , what        , build        , after = '')         {
  return String.raw`var ctx = core.begin(settings, dryRun);
${OPS_LOGIN}
var result = null;
try {
  result = mod.contentImport(ctx, settings.opsHost, auth, settings._secrets, {
    contentType: ${JSON.stringify(contentType)},
    what: ${JSON.stringify(what)},
    overwrite: settings.overwrite,
    build: function (ownerId, userName) {
${build}
    }
  });
  if (result && result.imported === 0) System.log("Already in VCF Operations: the import skipped it (force=false) and left it as it is. Set overwrite to true to replace it.");${after}
} finally {
  core.logoutVcfOps(settings.opsHost, auth);
}
importId = result ? result.id : "";
summary = core.audit(ctx, { what: ${JSON.stringify(what)}, importId: importId, imported: result ? result.imported : 0, skipped: result ? result.skipped : 0 });
core.notify(settings.webhook, summary);`;
}

/** Export the same kind of content from the target, as the reference layout. */
function exportReferenceScript(contentType        )         {
  return readScript(PLATFORM, `Export existing ${contentType} content as the reference layout for an import.`, [
    ...workDirLines(PLATFORM),
    'API="https://${VCFOPS_HOST}/suite-api/api/content/operations"',
    `jq -n '{scope: "CUSTOM", contentTypes: ["${contentType}"]}' | curl -sS -f -X POST "$API/export" -H "${authHeader(PLATFORM)}" -H "Accept: application/json" -H "Content-Type: application/json" --data-binary @- >/dev/null`,
    'state=""',
    'for _ in $(seq 1 60); do',
    '  sleep 5',
    `  state=$(curl -sS -f "$API/export" -H "${authHeader(PLATFORM)}" -H "Accept: application/json" | jq -r '.state // "UNKNOWN"') || continue`,
    '  case "$state" in FINISHED|FAILED) break ;; esac',
    'done',
    '[[ "$state" == FINISHED ]] || { echo "The export did not finish (state: ${state:-none})." >&2; exit 1; }',
    `curl -sS -f "$API/export/zip" -H "${authHeader(PLATFORM)}" -o reference-export.zip`,
    'unzip -l reference-export.zip',
    'echo "Compare this layout with the zip the import script builds before importing."',
  ]);
}

// ---------------------------------------------------------------------------
// Dashboards and views: the templates
// ---------------------------------------------------------------------------

                  
                        
                         
                     
                     
                     
                     
                                           
 

                      
                       
                         
                              
 

                        
                        
                        
                                                           
                                          
                          
 

const TEMPLATES = [
  { value: 'capacity', label: 'Cluster capacity overview' },
  { value: 'tier1', label: 'Tier 1 application health' },
  { value: 'tags', label: 'Tag compliance' },
  { value: 'reclaim', label: 'Reclamation' },
  { value: 'certs', label: 'Fleet certificate expiry' },
]         ;

const templateName = (value        )         => TEMPLATES.find((t) => t.value === value)?.label ?? 'Cluster capacity overview';

const KIND_OPTIONS = [
  { value: 'VirtualMachine', label: 'Virtual machine' },
  { value: 'HostSystem', label: 'ESXi host' },
  { value: 'ClusterComputeResource', label: 'Cluster' },
  { value: 'Datastore', label: 'Datastore' },
  { value: 'VirtualCenter', label: 'vCenter' },
];

/**
 * The view behind each dashboard template.
 *
 * Metric keys are the VMware adapter's. `summary|tag` is the property that
 * carries a VM's vSphere tags as text; its exact key and value format vary
 * between releases, so the tag views say VERIFY.
 */
function viewTemplate(template        , tagCategories                   )               {
  switch (template) {
    case 'tier1':
      return {
        name: templateName(template),
        kind: 'VirtualMachine',
        presentation: 'list',
        columns: [
          { key: 'badge|health', label: 'Health' },
          { key: 'cpu|readyPct', label: 'CPU ready %' },
          { key: 'mem|guest_usage', label: 'Guest memory %' },
          { key: 'virtualDisk|totalLatency', label: 'Disk latency (ms)' },
          { key: 'summary|parentHost', label: 'Host', property: true },
        ],
        filter: 'Members of the Tier 1 custom group (set on the dashboard, not the view)',
      };
    case 'tags':
      return {
        name: templateName(template),
        kind: 'VirtualMachine',
        presentation: 'list',
        columns: [
          { key: 'summary|tag', label: 'vSphere tags', property: true },
          ...tagCategories.map((category) => ({ key: 'summary|tag', label: `Has ${category}`, property: true })),
          { key: 'summary|parentCluster', label: 'Cluster', property: true },
          { key: 'summary|runtime|powerState', label: 'Power state', property: true },
        ],
        filter: tagCategories.length > 0 ? `summary|tag does not contain any of: ${tagCategories.join(', ')}` : 'none',
      };
    case 'reclaim':
      return {
        name: templateName(template),
        kind: 'VirtualMachine',
        presentation: 'list',
        columns: [
          { key: 'summary|runtime|powerState', label: 'Power state', property: true },
          { key: 'cpu|usage_average', label: 'CPU usage %' },
          { key: 'diskspace|snapshot', label: 'Snapshot space (GB)' },
          { key: 'config|hardware|num_Cpu', label: 'vCPU', property: true },
          { key: 'config|hardware|memoryKB', label: 'Memory (KB)', property: true },
        ],
        filter: 'Powered off, idle, or holding snapshot space',
      };
    case 'certs':
      return {
        name: templateName(template),
        kind: 'VirtualCenter',
        presentation: 'list',
        columns: [
          { key: 'summary|version', label: 'Version', property: true },
          { key: '<REQUIRED — the certificate-expiry property or metric key in your release; VERIFY on an object’s property list>', label: 'Days to certificate expiry', property: true },
        ],
        filter: 'none',
      };
    default:
      return {
        name: templateName('capacity'),
        kind: 'ClusterComputeResource',
        presentation: 'list',
        columns: [
          { key: 'OnlineCapacityAnalytics|capacityRemainingPercentage', label: 'Capacity remaining %' },
          { key: 'OnlineCapacityAnalytics|timeRemaining', label: 'Time remaining (days)' },
          { key: 'cpu|demandPct', label: 'CPU demand %' },
          { key: 'mem|host_usagePct', label: 'Memory usage %' },
          { key: 'summary|number_running_vms', label: 'Running VMs' },
        ],
        filter: 'none',
      };
  }
}

function widgetsFor(template        , viewName        , groupName        , tagCategories                   )           {
  const viewId = viewIdOf(viewName);
  const kind = (resourceKind        ) => ({ adapterKind: 'VMWARE', resourceKind });
  const about = (text        )         => ({ type: 'TextDisplay', title: 'About this dashboard', x: 1, y: 1, w: 12, h: 2, config: { text } });
  switch (template) {
    case 'tier1':
      return [
        about(`Tier 1 applications: every VM in the custom group "${groupName}". Select one on the left; everything else follows it.`),
        { type: 'ResourceList', title: 'Tier 1 VMs', x: 1, y: 3, w: 4, h: 8, config: { selfProvider: true, customGroup: groupName, resourceKinds: [kind('VirtualMachine')] } },
        { type: 'HealthChart', title: 'Health, last 24 hours', x: 5, y: 3, w: 8, h: 4, config: { metric: 'badge|health', period: 'LAST_24_HOURS' } },
        { type: 'Scoreboard', title: 'Right now', x: 5, y: 7, w: 8, h: 4, config: { metrics: ['cpu|readyPct', 'mem|guest_usage', 'virtualDisk|totalLatency'] } },
        { type: 'View', title: 'Tier 1 detail', x: 1, y: 11, w: 12, h: 6, config: { viewDefinitionId: viewId } },
      ];
    case 'tags':
      return [
        about(`Tag compliance: VMs missing any of the required tag categories (${tagCategories.join(', ') || 'none set'}). An untagged VM is one no automation can scope correctly.`),
        { type: 'Scoreboard', title: 'VMs missing a required tag', x: 1, y: 3, w: 4, h: 4, config: { selfProvider: true, resourceKinds: [kind('VirtualMachine')], metrics: ['summary|tag'] } },
        { type: 'Heatmap', title: 'Untagged VMs by cluster', x: 5, y: 3, w: 8, h: 4, config: { groupBy: 'ClusterComputeResource', colorBy: 'summary|tag' } },
        { type: 'View', title: 'VMs and their tags', x: 1, y: 7, w: 12, h: 8, config: { viewDefinitionId: viewId } },
      ];
    case 'reclaim':
      return [
        about('Reclamation: powered-off VMs, idle VMs and snapshot space, largest first. Review here; reclaim with the scheduled reclamation automation, not by hand from this page.'),
        { type: 'TopN', title: 'Largest snapshots', x: 1, y: 3, w: 4, h: 6, config: { metric: 'diskspace|snapshot', topN: 10, order: 'DESCENDING', resourceKinds: [kind('VirtualMachine')] } },
        { type: 'TopN', title: 'Most idle', x: 5, y: 3, w: 4, h: 6, config: { metric: 'cpu|usage_average', topN: 10, order: 'ASCENDING', resourceKinds: [kind('VirtualMachine')] } },
        { type: 'Scoreboard', title: 'Reclaimable', x: 9, y: 3, w: 4, h: 6, config: { metrics: ['OnlineCapacityAnalytics|reclaimableCapacity'] } },
        { type: 'View', title: 'Reclamation candidates', x: 1, y: 9, w: 12, h: 8, config: { viewDefinitionId: viewId } },
      ];
    case 'certs':
      return [
        about('Fleet certificates: expiry is tracked in Fleet Management > Certificates in VCF 9.1. This dashboard shows the alerts raised from it; renew with the fleet certificate automation.'),
        { type: 'AlertList', title: 'Certificate alerts', x: 1, y: 3, w: 12, h: 6, config: { alertNameContains: 'certificate', status: 'ACTIVE' } },
        { type: 'View', title: 'vCenter certificate expiry', x: 1, y: 9, w: 12, h: 6, config: { viewDefinitionId: viewId } },
      ];
    default:
      return [
        about('Cluster capacity: what is left, how long it lasts, and which cluster runs out first. Select a cluster on the left.'),
        { type: 'ResourceList', title: 'Clusters', x: 1, y: 3, w: 4, h: 6, config: { selfProvider: true, resourceKinds: [kind('ClusterComputeResource')] } },
        { type: 'Scoreboard', title: 'Capacity remaining', x: 5, y: 3, w: 4, h: 6, config: { metrics: ['OnlineCapacityAnalytics|capacityRemainingPercentage', 'OnlineCapacityAnalytics|timeRemaining'] } },
        { type: 'TopN', title: 'Least time remaining', x: 9, y: 3, w: 4, h: 6, config: { metric: 'OnlineCapacityAnalytics|timeRemaining', topN: 10, order: 'ASCENDING', resourceKinds: [kind('ClusterComputeResource')] } },
        { type: 'View', title: 'Cluster capacity', x: 1, y: 9, w: 12, h: 6, config: { viewDefinitionId: viewId } },
        { type: 'Heatmap', title: 'CPU demand by cluster', x: 1, y: 15, w: 6, h: 6, config: { groupBy: 'ClusterComputeResource', sizeBy: 'cpu|demandmhz', colorBy: 'cpu|demandPct' } },
        { type: 'HealthChart', title: 'CPU demand trend', x: 7, y: 15, w: 6, h: 6, config: { metric: 'cpu|demandPct', period: 'LAST_7_DAYS' } },
      ];
  }
}

/** Extra widgets, one per line: "Type | Title | x,y,w,h". */
function extraWidgets(text        )                                       {
  const widgets           = [];
  const bad           = [];
  for (const line of text.split('\n').map((l) => l.trim()).filter(Boolean)) {
    const [type = '', title = '', coords = ''] = line.split('|').map((part) => part.trim());
    const [x, y, w, h] = coords.split(',').map((n) => Number(n.trim()));
    if (!type || ![x, y, w, h].every((n) => Number.isInteger(n) && (n          ) > 0)) {
      bad.push(line);
      continue;
    }
    widgets.push({ type, title: title || type, x: x , y: y , w: w , h: h , config: {} });
  }
  return { widgets, bad };
}

function overlaps(a        , b        )          {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** A property whose value is text rather than a number, for isStringAttribute. */
function isStringProperty(column            )          {
  return column.property === true && !/num_|memoryKB|corecount|number_|Count$|capacity/i.test(column.key);
}

/**
 * The view as content.xml — the shape of a Views → Export: ViewDef with Title,
 * Description, SubjectType, Usage, and Controls holding a time-interval selector
 * and an attributes selector whose items are the columns, then DataProviders and
 * Presentation (notoriousbdg and sentania-labs exports; see vcfops-import.ts).
 */
function viewXml(view              , description        )         {
  const id = viewIdOf(view.name);
  const items = view.columns.flatMap((column) => [
    '                                <Item>',
    '                                    <Value>',
    '                                        <Property name="objectType" value="RESOURCE"/>',
    `                                        <Property name="attributeKey" value="${xml(column.key)}"/>`,
    `                                        <Property name="isStringAttribute" value="${isStringProperty(column)}"/>`,
    '                                        <Property name="adapterKind" value="VMWARE"/>',
    `                                        <Property name="resourceKind" value="${xml(view.kind)}"/>`,
    ...(column.property ? [] : ['                                        <Property name="rollUpType" value="NONE"/>']),
    '                                        <Property name="rollUpCount" value="0"/>',
    '                                        <Property name="transformations">',
    '                                            <List>',
    '                                                <Item value="CURRENT"/>',
    '                                            </List>',
    '                                        </Property>',
    `                                        <Property name="isProperty" value="${column.property ? 'true' : 'false'}"/>`,
    `                                        <Property name="displayName" value="${xml(column.label)}"/>`,
    '                                    </Value>',
    '                                </Item>',
  ]);
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Content>',
    '    <Views>',
    `        <ViewDef id="${id}">`,
    `            <Title>${xml(view.name)}</Title>`,
    `            <Description>${xml(description)}</Description>`,
    `            <SubjectType adapterKind="VMWARE" resourceKind="${xml(view.kind)}" type="descendant"/>`,
    `            <SubjectType adapterKind="VMWARE" resourceKind="${xml(view.kind)}" type="self"/>`,
    '            <Usage>dashboard</Usage>',
    '            <Usage>report</Usage>',
    '            <Usage>details</Usage>',
    '            <Usage>content</Usage>',
    '            <Controls>',
    '                <Control id="time-interval-selector_id_1" type="time-interval-selector" visible="false">',
    '                    <Property name="advancedTimeMode" value="false"/>',
    `                    <Property name="unit" value="${view.presentation === 'list' ? 'HOURS' : 'DAYS'}"/>`,
    `                    <Property name="count" value="${view.presentation === 'list' ? 24 : 30}"/>`,
    '                </Control>',
    '                <Control id="attributes-selector_id_1" type="attributes-selector" visible="false">',
    '                    <Property name="attributeInfos">',
    '                        <List>',
    ...items,
    '                        </List>',
    '                    </Property>',
    '                </Control>',
    ...(view.presentation === 'list'
      ? [
          '                <Control id="pagination-control_id_1" type="pagination-control" visible="true">',
          '                    <Property name="start" value="0"/>',
          '                    <Property name="size" value="50"/>',
          '                </Control>',
        ]
      : []),
    '                <Control id="metadata_id_1" type="metadata" visible="false">',
    '                    <Property name="maxPointsCount" value="5000"/>',
    '                    <Property name="hideObjectNameColumn" value="false"/>',
    '                    <Property name="listTopResultSize" value="-1"/>',
    '                </Control>',
    '            </Controls>',
    '            <DataProviders>',
    `                <DataProvider dataType="${view.presentation}-view" id="${view.presentation}-view_id_1"/>`,
    '            </DataProviders>',
    `            <Presentation type="${view.presentation}"/>`,
    '        </ViewDef>',
    '    </Views>',
    '</Content>',
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// VCF Operations: build
// ---------------------------------------------------------------------------

export const VCF_OPS_BUILD                                 = [
  // -------------------------------------------------------------------------
  automationBlueprint({
    id: 'vcfops_dashboard',
    platform: PLATFORM,
    label: 'A dashboard, as importable JSON',
    group: 'Dashboards and reports',
    description:
      'A dashboard written as the JSON a dashboard export holds — widgets laid out by gridsterCoords on a 12-column grid, the first list driving the rest — from one of five templates. The layout is checked for overlaps before it is imported, and the file reads back on the Aria Ops page like any exported dashboard.',
    inputs: [
      { id: 'template', label: 'Template', control: 'select', options: TEMPLATES.map((t) => ({ value: t.value, label: t.label })), default: 'capacity' },
      { id: 'dashboard_name', label: 'Dashboard name', control: 'text', default: '', placeholder: 'Defaults to the template name' },
      { id: 'group_name', label: 'Tier 1 custom group', control: 'text', default: 'Tier 1 Applications', showWhen: { input: 'template', equals: ['tier1'] } },
      { id: 'tag_categories', label: 'Required tag categories', control: 'text', default: 'Owner, Environment, CostCentre', showWhen: { input: 'template', equals: ['tags'] } },
      { id: 'shared', label: 'Share with all users', control: 'toggle', default: true },
      { id: 'extra', label: 'Extra widgets', control: 'textarea', default: '', hint: 'One per line: Type | Title | x,y,w,h — x is 1 to 12' },
      { id: 'max_widgets', label: 'Warn above (widgets)', control: 'number', default: 10, min: 1, max: 40, hint: 'Every widget is a query on every refresh' },
    ],
    automation: (values                 , name        )             => {
      const template = str(values, 'template', 'capacity');
      const dashName = str(values, 'dashboard_name', templateName(template));
      const groupName = str(values, 'group_name', 'Tier 1 Applications');
      const tags = listOf(str(values, 'tag_categories', ''));
      const shared = bool(values, 'shared', true);
      const maxWidgets = num(values, 'max_widgets', 10);
      const viewName = templateName(template);

      const extra = extraWidgets(str(values, 'extra', ''));
      const widgets = [...widgetsFor(template, viewName, groupName, tags), ...extra.widgets];

      const findings            = [];
      for (const line of extra.bad) {
        findings.push(error('vcfops.dashboard.bad-widget', `"${line}" is not Type | Title | x,y,w,h with four positive whole numbers.`, { source: SRC }));
      }
      const clashes           = [];
      for (let i = 0; i < widgets.length; i += 1) {
        for (let j = i + 1; j < widgets.length; j += 1) {
          if (overlaps(widgets[i] , widgets[j] )) clashes.push(`"${widgets[i] .title}" and "${widgets[j] .title}"`);
        }
      }
      if (clashes.length > 0) {
        findings.push(
          error('vcfops.dashboard.overlap', `Widgets overlap on the grid: ${clashes.join('; ')}.`, {
            remediation: 'Gridster pushes overlapping widgets down on import, so the dashboard you open is not the one you wrote. Move them so no two rectangles share a cell.',
            source: SRC,
          }),
        );
      }
      const offGrid = widgets.filter((widget) => widget.x + widget.w - 1 > 12);
      if (offGrid.length > 0) {
        findings.push(error('vcfops.dashboard.off-grid', `${offGrid.map((w) => `"${w.title}"`).join(', ')} run${offGrid.length === 1 ? 's' : ''} past column 12.`, { remediation: 'x + w − 1 must be 12 or less on a 12-column dashboard.', source: SRC }));
      }
      if (widgets.length > maxWidgets) {
        findings.push(
          warning('vcfops.dashboard.too-many', `${widgets.length} widgets, more than the ${maxWidgets} you set as a limit.`, {
            remediation: 'Each widget queries on every refresh, for every viewer. Split it into two dashboards linked by a navigation widget.',
            source: SRC,
          }),
        );
      }
      if (template === 'tags' && tags.length === 0) {
        findings.push(warning('vcfops.dashboard.no-tags', 'No tag categories are required, so the tag compliance dashboard has nothing to test.', { source: SRC }));
      }

      const ids = widgets.map((widget, index) => stableId(`widget:${dashName}:${index}:${widget.title}`));
      const provider = widgets.findIndex((widget) => widget.config['selfProvider'] === true);
      const dashId = stableId(`dashboard:${dashName}`);
      // Written as a Dashboards → Export writes it (notoriousbdg and sentania-labs
      // exports): {entries, dashboards, uuid}; flags as objects ({selfProvider:
      // {selfProvider: true}}); widgets wired by widgetInteractions.
      const widgetConfig = (widget        , index        )                          => {
        const { selfProvider, ...rest } = widget.config;
        const common = { title: widget.title, refreshInterval: 300, refreshContent: { refreshContent: true }, selfProvider: { selfProvider: selfProvider === true || index === provider } };
        return widget.type === 'View'
          ? { ...common, ...rest, isUpdatedView: true, chartViewItems: [], selectFirstRow: { selectFirstRow: false }, traversalSpecId: '', resource: null }
          : { ...common, ...rest };
      };
      const dashboard = {
        entries: { resourceKind: [], resource: [] },
        dashboards: [
          {
            id: dashId,
            name: dashName,
            namePath: '',
            description: `Generated by ArchToolKit from the "${viewName}" template.`,
            shared,
            temporary: false,
            hidden: false,
            homeTab: false,
            disabled: false,
            locked: false,
            autoswitchEnabled: false,
            columnCount: 1,
            columnProportion: '1',
            gridsterMaxColumns: 12,
            rank: 0,
            creationTime: 0,
            lastUpdateTime: 0,
            importAttempts: 0,
            importComplete: true,
            userId: DASHBOARD_OWNER_PLACEHOLDER,
            lastUpdateUserId: DASHBOARD_OWNER_PLACEHOLDER,
            states: [],
            dashboardNavigations: {},
            // Selecting an object in the first list drives every other widget.
            widgetInteractions:
              provider >= 0
                ? ids.filter((_, index) => index !== provider && widgets[index] .type !== 'TextDisplay').map((receiver) => ({ type: 'resourceId', widgetIdProvider: ids[provider], widgetIdReceiver: receiver }))
                : [],
            widgets: widgets.map((widget, index) => ({
              id: ids[index],
              type: widget.type,
              title: widget.title,
              collapsed: false,
              gridsterCoords: { x: widget.x, y: widget.y, w: widget.w, h: widget.h },
              config: widgetConfig(widget, index),
            })),
          },
        ],
        uuid: stableId(`dashboard-export:${dashName}`),
      };
      const dashboardJson = `${JSON.stringify(dashboard, null, 2)}\n`;

      const hasView = widgets.some((widget) => widget.type === 'View');
      const base = slugOf(name || dashName, 'dashboard');
      const packageName = packageNameOf('vcfops', 'dashboard', base);
      // The content-management layout import-dashboard.sh writes, built inside
      // the workflow once it knows the owner: dashboards/<owner> (a zip of
      // dashboard/dashboard.json), dashboardsharings/<owner>, usermappings.json.
      const build = String.raw`      var text = core.resource(RESOURCE_PATH, "dashboard.json").split(${JSON.stringify(DASHBOARD_OWNER_PLACEHOLDER)}).join(ownerId);
      var dashboards = JSON.parse(text).dashboards || [];
      var inner = mod.zipStored([
        { name: "dashboard/dashboard.json", data: mod.ascii(text, "json"), pad: "text" },
        { name: "dashboard/resources/resources.properties", data: "", pad: "text" }
      ]);
      var entries = [{ name: "dashboards/" + ownerId, data: inner, pad: "zip" }];
      if (${shared ? 'true' : 'false'}) {
        var shares = [];
        for (var i = 0; i < dashboards.length; i++) shares.push({ dashboardId: dashboards[i].id });
        entries.push({ name: "dashboardsharings/" + ownerId, data: mod.ascii(JSON.stringify([{ groupName: "Everyone", sourceType: "LOCAL", dashboards: shares }]), "json"), pad: "text" });
      }
      entries.push({ name: "usermappings.json", data: mod.ascii(JSON.stringify({ sources: [], users: [{ userName: userName, userId: ownerId }] }), "json"), pad: "text" });
      entries.push({ name: "configuration.json", data: JSON.stringify({ dashboards: dashboards.length, dashboardsByOwner: [{ owner: ownerId, count: dashboards.length }], type: "CUSTOM" }), pad: "text" });
      return { entries: entries };`;
      const pkg = toPackage({
        packageName,
        description: `Imports the VCF Operations dashboard "${dashName}" through Content Management, as the account in the settings. Generated by ArchToolKit.`,
        categoryPath: `ArchToolKit/VCF Operations/${base}`,
        workflow: {
          name: `Import dashboard ${base}`,
          description: `Imports the dashboard "${dashName}" (${widgets.length} widgets) through Content Management: exports DASHBOARDS first (the backup, and the instance marker), then imports with force=false unless overwrite is set, so a dashboard already there is left as it is. A dry run until dryRun is set to false in the configuration element.`,
          inputs: [{ name: 'dryRun', type: 'boolean', description: 'true: read and report what would be imported, change nothing' }],
          outputs: [
            { name: 'importId', type: 'string', description: 'The Content Management import id, empty in a dry run' },
            { name: 'summary', type: 'string', description: 'The audit record, JSON' },
          ],
          script: contentWorkflow('DASHBOARDS', `the dashboard "${dashName}"`, build),
        },
        actions: contentActions(packageName),
        config: {
          name: 'Settings',
          description: `Settings of the Import dashboard ${base} workflow. Fill opsPassword after import; set dryRun to false only after a dry run.`,
          attributes: contentAttributes(1),
        },
        resources: [{ name: 'dashboard.json', content: dashboardJson }],
      });
      return {
        platform: PLATFORM,
        title: `Dashboard "${dashName}" — ${widgets.length} widgets`,
        effect: 'reversible',
        trigger: { kind: 'manual', detail: 'Imported once by a person; it changes when someone edits it in the interface and re-exports it.', worstCase: 'once per import' },
        scope: {
          what: `One dashboard, "${dashName}", ${shared ? 'shared with every user' : 'visible to the importing user'}.`,
          decidedBy: [
            'The dashboard id, derived from its name: importing it again replaces this dashboard and nothing else.',
            ...(template === 'tier1' ? [`The custom group "${groupName}" decides which VMs the list shows.`] : []),
            hasView ? `The view "${viewName}" (id ${viewIdOf(viewName)}) must exist, from "A view for dashboards and reports".` : 'No view.',
          ],
          ifWrong: 'With --overwrite, a dashboard with the same name or id that somebody edited by hand is replaced by this one; their version is in the pre-import-backup zip the script took first. Without --overwrite the script refuses.',
        },
        guardrails: [
          { rule: 'Overlapping or off-grid widgets are an error before anything is built', because: 'Gridster rearranges an overlapping layout on import, and the dashboard people open is not the one that was reviewed.' },
          { rule: 'import-dashboard.sh stops while any payload holds <REQUIRED>', because: 'A dashboard imported with a placeholder view id shows an empty widget, which reads as "no problems".' },
          { rule: 'Dry run by default: builds and lists the zip, sends nothing', because: 'The content-zip layout comes from real exports rather than a published specification; the first run is for comparing it with an export-reference.sh export.' },
          { rule: 'With --execute, the script first exports the existing DASHBOARDS content to pre-import-backup-<time>.zip and refuses to import when a dashboard with the same name or id is already there, unless --overwrite is given', because: 'The import API overwrites by default (force defaults to true), and somebody’s hand-edited copy would be gone with no copy kept.' },
          { rule: 'The import is sent with force=false unless --overwrite', because: 'Without it the API replaces whatever matches, which is the documented default.' },
          { rule: 'The script follows the import by the id its POST returned and exits 1 unless it reaches FINISHED with nothing failed or skipped, or when it times out', because: 'Reading the "last import" status can show an earlier import, and a FAILED import that exits 0 is taken as done.' },
          { rule: `The workflow Import dashboard ${base} is a dry run until dryRun is false in its configuration element, makes at most cap (1) import, refuses while another import runs or the payload holds <REQUIRED>, and imports with force=false unless overwrite is true`, because: 'An import started from the Orchestrator client with default inputs must not change anything, and force=false is what makes a second run skip the dashboard instead of replacing it.' },
        ],
        dryRun: [
          `Run the workflow Import dashboard ${base} with dryRun = true: it logs in, reads who it would import as, lists the package entries and logs "DRY RUN: would import …".`,
          'Run import-dashboard.sh without --execute: it builds the content zip and lists it.',
          'Drop import/dashboard.zip on the Aria Ops page first — it reads it as an export and shows the layout and any findings.',
          'Or import it by hand: Dashboards > Manage > Import, which takes import/dashboard.zip.',
        ],
        undo: ['Delete the dashboard under Dashboards > Manage. If --overwrite (or overwrite in the workflow settings) replaced one, put the previous version back by importing the backup export — the pre-import-backup-<time>.zip the script wrote, or the export the workflow made just before its import (Content Management, latest export) — the import API itself has no undo.'],
        told: ['Nobody. The dashboard appears in the list for the users it is shared with.'],
        requires: [
          ...(hasView ? [`The view "${viewName}", generated by "A view for dashboards and reports" with the same template, imported first.`] : []),
          'zip, unzip, jq and curl on the machine running the script.',
          'An account allowed to import content (Content admin or Administrator).',
          'For the package: VCF Automation 9.1 (or VCF Operations orchestrator 9.1) with the VCF Operations certificate trusted in Orchestrator.',
        ],
        files: {
          ...pkg.files,
          'import/dashboard.zip/dashboard/dashboard.json': dashboardJson,
          'import/dashboard.zip/dashboard/resources/resources.properties': '',
          'import/dashboard.json': dashboardJson,
          ...contentPackage({}, {}),
          'import-dashboard.sh': contentImportScript({ what: `the dashboard "${dashName}"`, contentType: 'DASHBOARDS', needles: [`"name": ${JSON.stringify(dashName)}`, `"name":${JSON.stringify(dashName)}`, dashId], dashboard: { shared } }),
          'export-reference.sh': exportReferenceScript('DASHBOARDS'),
          'IMPORT.md': importMd({
            title: `the dashboard "${dashName}"`,
            steps: [
              ...packageSteps(pkg, 'imports the dashboard'),
              ...(hasView
                ? [{ heading: `Before the first live run: the view "${viewName}"`, files: [], how: [`Generate "A view for dashboards and reports" with the "${viewName}" template and import it first (its own package, or its import/view.zip). The View widget refers to view id ${viewIdOf(viewName)}; without it the widget opens empty.`] }]
                : []),
              {
                heading: 'How the workflow imports it',
                files: [],
                how: [
                  'The only public way into VCF Operations for a dashboard is Content Management (POST /suite-api/api/content/operations/import, multipart contentFile). The workflow does what import-dashboard.sh does: GET /suite-api/api/auth/currentuser (the owner the dashboard is filed under), GET …/content/operations/import (refuses while another import runs), then as one guarded change POST …/content/operations/export {scope: CUSTOM, contentTypes: [DASHBOARDS]} and GET …/export until this export has FINISHED (the backup), GET …/export/zip for the instance\'s <number>L.v1 marker name, POST …/import?force=false (true only with overwrite) and GET …/import until the import with the returned id has FINISHED.',
                  'The package is dashboards/<owner id> (a zip of dashboard/dashboard.json), dashboardsharings/<owner id> when shared, usermappings.json and configuration.json — the layout sentania-labs/vcf-content-factory-bundles installs on VCF Operations 9, with the importing user\'s id in the marker file as its install.py writes it.',
                ],
                verify: [
                  'the REST plugin sends the zip as a string: every CRC, size and offset in it is built without bytes above 0x7F, and all text is ASCII-escaped, so it arrives byte for byte; only the marker file\'s CRC can have such a byte, and the upload declares charset=ISO-8859-1 for it. If the import on your release reports the package unreadable, use import-dashboard.sh.',
                ],
              },
              {
                heading: 'The dashboard',
                files: ['import/dashboard.zip'],
                how: ['Dashboards → Manage → ⋯ → Import (8.x: Dashboards → Actions → Manage Dashboards → Import Dashboards), and choose import/dashboard.zip — a zip holding dashboard/dashboard.json, as a dashboard export is.', 'The dashboard is created as the user who imports it, then shared if the shared flag is set.'],
                verify: ['import/dashboard.json is the same dashboard as a bare file. Import dialogs have taken the .json on its own in 8.x; if yours asks for a zip, use import/dashboard.zip.', 'widget config keys other than viewDefinitionId, selfProvider and refresh are a starting point: open each widget after import and save it once if it shows unconfigured.'],
              },
              contentStep('DASHBOARDS', 'import-dashboard.sh'),
            ],
            sources: FORMAT_SOURCES,
          }),
        },
        notes: [
          CONTENT_IMPORT_NOTE,
          'The {entries, dashboards[], uuid} shape, widgets[] with gridsterCoords and widgetInteractions are as real exports have them, and the Aria Ops page parses the same file. Widget config keys beyond viewDefinitionId (metrics, topN, groupBy and so on) are a starting point: VERIFY them against a widget of the same type exported from your release, and edit the widget in the interface after import if it opens unconfigured.',
          'gridsterCoords are 1-based: x runs 1 to 12, y from 1 downwards.',
          'widgetInteractions wires the first self-providing list to every other widget. That is the usual "select one, see its detail" shape; a widget that should not follow the selection can be unwired in the dashboard editor.',
        ],
        findings,
      };
    },
  }),

  // -------------------------------------------------------------------------
  automationBlueprint({
    id: 'vcfops_view',
    platform: PLATFORM,
    label: 'A view for dashboards and reports',
    group: 'Dashboards and reports',
    description:
      'A list, trend or distribution view — an object type, its columns as metrics and properties (tag properties included), and a filter — written as content XML, so it can be used by a dashboard’s View widget and by a report. The id is derived from the name, so the dashboard template of the same name already points at it.',
    inputs: [
      { id: 'template', label: 'Start from', control: 'select', options: [...TEMPLATES.map((t) => ({ value: t.value, label: t.label })), { value: 'custom', label: 'My own columns' }], default: 'capacity' },
      { id: 'view_name', label: 'View name', control: 'text', default: 'VM right-sizing', showWhen: { input: 'template', equals: ['custom'] } },
      { id: 'kind', label: 'Object type', control: 'select', options: KIND_OPTIONS, default: 'VirtualMachine', showWhen: { input: 'template', equals: ['custom'] } },
      {
        id: 'presentation',
        label: 'Presentation',
        control: 'select',
        options: [
          { value: 'list', label: 'List' },
          { value: 'trend', label: 'Trend' },
          { value: 'distribution', label: 'Distribution' },
        ],
        default: 'list',
        showWhen: { input: 'template', equals: ['custom'] },
      },
      {
        id: 'columns',
        label: 'Columns',
        control: 'textarea',
        default: 'cpu|usage_average | CPU usage %\nmem|guest_usage | Guest memory %\nconfig|hardware|num_Cpu | vCPU | property',
        hint: 'One per line: key | label, and "| property" for a property rather than a metric',
        showWhen: { input: 'template', equals: ['custom'] },
      },
      { id: 'filter', label: 'Filter', control: 'text', default: 'none', showWhen: { input: 'template', equals: ['custom'] } },
      { id: 'tag_categories', label: 'Tag categories to show', control: 'text', default: 'Owner, Environment', hint: 'Adds the vSphere tag property as a column' },
      { id: 'include_tags', label: 'Include tag columns', control: 'toggle', default: false },
    ],
    automation: (values                 , name        )             => {
      const template = str(values, 'template', 'capacity');
      const tags = listOf(str(values, 'tag_categories', ''));
      const includeTags = bool(values, 'include_tags', false);
      let view              ;
      if (template === 'custom') {
        const columns = str(values, 'columns', '')
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean)
          .map((line)             => {
            // Metric keys contain "|" themselves, so fields are separated by " | ".
            const [key = '', label = '', flag = ''] = line.split(/\s+\|\s+/).map((part) => part.trim());
            return { key, label: label || key, property: flag.toLowerCase() === 'property' };
          })
          .filter((column) => column.key);
        view = {
          name: str(values, 'view_name', 'Custom view'),
          kind: str(values, 'kind', 'VirtualMachine'),
          presentation: str(values, 'presentation', 'list')                                ,
          columns,
          filter: str(values, 'filter', 'none'),
        };
      } else {
        view = viewTemplate(template, tags);
      }
      if (includeTags && template !== 'tags') {
        view = { ...view, columns: [...view.columns, ...tags.map((category) => ({ key: 'summary|tag', label: `Tag: ${category}`, property: true }))] };
      }

      const findings            = [];
      if (view.columns.length === 0) findings.push(error('vcfops.view.no-columns', 'A view with no columns shows the object names and nothing else.', { source: SRC }));
      if (view.presentation === 'trend' && view.columns.some((column) => column.property)) {
        findings.push(warning('vcfops.view.trend-property', 'A trend view over a property draws a flat line: properties are not time series.', { remediation: 'Use metrics in a trend view; put properties in a list.', source: SRC }));
      }
      if (view.presentation === 'distribution' && view.columns.length > 1) {
        findings.push(warning('vcfops.view.distribution-columns', 'A distribution view plots one value; only the first column is used.', { source: SRC }));
      }
      if (view.columns.some((column) => column.key === 'summary|tag')) {
        findings.push(info('vcfops.view.tag-property', 'Tag columns use the property summary|tag, which holds every tag on the object as one string.', { remediation: 'VERIFY the key and the value format on a tagged VM’s property list. A per-category column needs a filter on that string, not a separate key.', source: SRC }));
      }
      if (view.columns.some((column) => column.key.startsWith('<REQUIRED'))) {
        findings.push(warning('vcfops.view.required-key', 'A column key is still <REQUIRED>, so the import script will refuse to run.', { remediation: 'Find the key on an object’s metric or property list in your release and put it in the XML.', source: SRC }));
      }

      const content = viewXml(view, `Generated by ArchToolKit. Filter: ${view.filter}.`);
      const base = slugOf(name || view.name, 'view');
      const packageName = packageNameOf('vcfops', 'view', base);
      const pkg = toPackage({
        packageName,
        description: `Imports the VCF Operations view "${view.name}" through Content Management. Generated by ArchToolKit.`,
        categoryPath: `ArchToolKit/VCF Operations/${base}`,
        workflow: {
          name: `Import view ${base}`,
          description: `Imports the view "${view.name}" (id ${viewIdOf(view.name)}) through Content Management: exports VIEW_DEFINITIONS first (the backup, and the instance marker), then imports views.zip with force=false unless overwrite is set, so a view already there is left as it is. A dry run until dryRun is set to false in the configuration element.`,
          inputs: [{ name: 'dryRun', type: 'boolean', description: 'true: read and report what would be imported, change nothing' }],
          outputs: [
            { name: 'importId', type: 'string', description: 'The Content Management import id, empty in a dry run' },
            { name: 'summary', type: 'string', description: 'The audit record, JSON' },
          ],
          script: contentWorkflow(
            'VIEW_DEFINITIONS',
            `the view "${view.name}"`,
            String.raw`      var inner = mod.zipStored([{ name: "content.xml", data: mod.ascii(core.resource(RESOURCE_PATH, "view-content.xml"), "xml"), pad: "text" }]);
      return { entries: [
        { name: "views.zip", data: inner, pad: "zip" },
        { name: "configuration.json", data: JSON.stringify({ views: 1, type: "CUSTOM" }), pad: "text" }
      ] };`,
          ),
        },
        actions: contentActions(packageName),
        config: {
          name: 'Settings',
          description: `Settings of the Import view ${base} workflow. Fill opsPassword after import; set dryRun to false only after a dry run.`,
          attributes: contentAttributes(1),
        },
        resources: [{ name: 'view-content.xml', content, mimeType: 'application/xml' }],
      });

      return {
        platform: PLATFORM,
        title: `View "${view.name}" — ${view.presentation} of ${view.kind}, ${view.columns.length} columns`,
        effect: 'reversible',
        trigger: { kind: 'manual', detail: 'Imported once; used whenever a dashboard widget or a report renders it.', worstCase: 'every dashboard refresh that shows it' },
        scope: {
          what: `One view definition, id ${viewIdOf(view.name)}, over ${view.kind} objects.`,
          decidedBy: [`Object type ${view.kind}.`, `Filter: ${view.filter}.`, 'Whatever object the dashboard or report runs it against — the view itself has no fixed scope.'],
          ifWrong: 'With --overwrite, a view with the same name or id is replaced, and a report or dashboard that used the old columns now shows the new ones; the old view is in the pre-import-backup zip. Without --overwrite the script refuses.',
        },
        guardrails: [
          { rule: 'The id comes from the name', because: 'Re-importing an edited view replaces it rather than creating a second one with the same title, which is how estates end up with four "VM Inventory" views.' },
          { rule: 'import-view.sh stops while the XML holds <REQUIRED>', because: 'A view with a placeholder column key imports cleanly and shows an empty column forever.' },
          { rule: 'Dry run by default: builds and lists the zip, sends nothing', because: 'The content-zip layout comes from real exports rather than a published specification; the first run is for comparing it with an export-reference.sh export.' },
          { rule: 'With --execute, the script first exports the existing VIEW_DEFINITIONS content to pre-import-backup-<time>.zip and refuses to import when a view with the same name or id is already there, unless --overwrite is given', because: 'The import API overwrites by default (force defaults to true), and somebody’s hand-edited copy would be gone with no copy kept.' },
          { rule: 'The import is sent with force=false unless --overwrite', because: 'Without it the API replaces whatever matches, which is the documented default.' },
          { rule: 'The script follows the import by the id its POST returned and exits 1 unless it reaches FINISHED with nothing failed or skipped, or when it times out', because: 'Reading the "last import" status can show an earlier import, and a FAILED import that exits 0 is taken as done.' },
          { rule: `The workflow Import view ${base} is a dry run until dryRun is false in its configuration element, makes at most cap (1) import, refuses while another import runs or the XML holds <REQUIRED>, and imports with force=false unless overwrite is true`, because: 'A view already there is skipped rather than replaced, so running the workflow twice changes nothing the second time.' },
        ],
        dryRun: [`Run the workflow Import view ${base} with dryRun = true: it logs in, lists the package entries and logs "DRY RUN: would import …".`, 'Run import-view.sh without --execute: it builds the content package, lists it and sends nothing.', 'Drop import/view.zip on the Aria Ops page: it reads ViewDef content and lists the view with its subject type.'],
        undo: ['Delete the view under Views > Manage. Delete any dashboard widget or report section that uses it first, or they show an error.', 'If --overwrite (or overwrite in the workflow settings) replaced a view, import the backup export — the pre-import-backup-<time>.zip the script wrote, or the export the workflow made just before its import — to put the previous one back.'],
        told: ['Nobody. It is a definition. The workflow posts its audit record to the webhook in its settings, if one is set.'],
        requires: ['zip, unzip, jq and curl for the scripts.', 'An account allowed to import content.', 'For the package: VCF Automation 9.1 (or VCF Operations orchestrator 9.1) with the VCF Operations certificate trusted in Orchestrator.'],
        files: {
          ...pkg.files,
          'import/view.zip/content.xml': content,
          'import/view.xml': content,
          ...contentPackage({ 'views.zip/content.xml': content }, { views: 1 }),
          'import-view.sh': contentImportScript({ what: `the view "${view.name}"`, contentType: 'VIEW_DEFINITIONS', needles: [`<Title>${xml(view.name)}</Title>`, viewIdOf(view.name)] }),
          'export-reference.sh': exportReferenceScript('VIEW_DEFINITIONS'),
          'IMPORT.md': importMd({
            title: `the view "${view.name}"`,
            steps: [
              ...packageSteps(pkg, 'imports the view'),
              {
                heading: 'How the workflow imports it',
                files: [],
                how: [
                  'VCF Operations has no public API for a single view: Content Management (POST /suite-api/api/content/operations/import, multipart contentFile) is the way in. The workflow reads GET /suite-api/api/auth/currentuser and GET …/content/operations/import (refuses while another import runs); then, as one guarded change, POST …/content/operations/export {scope: CUSTOM, contentTypes: [VIEW_DEFINITIONS]} (the backup), GET …/export/zip for the instance\'s <number>L.v1 marker, POST …/import?force=false (true only with overwrite) with views.zip (holding content.xml) and configuration.json, and GET …/import until the import with the returned id has FINISHED.',
                ],
                verify: ['the zip is sent through the REST plugin as a string, built so every byte is below 0x80 except possibly the marker file\'s CRC (the upload declares charset=ISO-8859-1). If the import reports the package unreadable, use import-view.sh.'],
              },
              {
                heading: 'The view',
                files: ['import/view.zip'],
                how: ['Views → Manage → ⋯ → Import (8.x: Dashboards → Views → Import), and choose import/view.zip — a zip holding content.xml, as a view export is.', `The view keeps id ${viewIdOf(view.name)}, which is the id the dashboard and report blueprints refer to.`],
                verify: [
                  'import/view.xml is the same content.xml as a bare file, for dialogs that take the XML on its own.',
                  ...(view.presentation === 'list' ? [] : [`a ${view.presentation} view is written with DataProvider dataType "${view.presentation}-view" and Presentation type "${view.presentation}"; only the list form is confirmed from a real export. Open the view in the editor after import and check it draws.`]),
                  ...(view.filter && view.filter !== 'none' ? [`the filter ("${view.filter}") is in the description only: set it in the view editor after import.`] : []),
                ],
              },
              contentStep('VIEW_DEFINITIONS', 'import-view.sh'),
            ],
            sources: FORMAT_SOURCES,
          }),
        },
        notes: [
          CONTENT_IMPORT_NOTE,
          'DASHBOARDS, VIEW_DEFINITIONS and REPORT_DEFINITIONS are in the contentTypes enum of POST /content/operations/export in the VCF Operations API reference; the backup export uses scope CUSTOM with just that type.',
          'The attributes-selector items follow a real export; for a column type not seen there, build one column in the view editor, export it, and compare its <Item> block.',
        ],
        findings,
      };
    },
  }),

  // -------------------------------------------------------------------------
  automationBlueprint({
    id: 'vcfops_report',
    platform: PLATFORM,
    label: 'A report from views, on a schedule',
    group: 'Dashboards and reports',
    description:
      'A report definition made of named views, in PDF, CSV or both, imported as content, and then scheduled with POST /reportdefinitions/{id}/schedules to a team address. The views are referred to by the same name-derived ids the view blueprint writes.',
    inputs: [
      { id: 'report_name', label: 'Report name', control: 'text', default: 'Monthly capacity and reclamation' },
      { id: 'views', label: 'Views, in order', control: 'textarea', default: 'Cluster capacity overview\nReclamation', hint: 'One view name per line, as generated by the view blueprint' },
      { id: 'kind', label: 'Run against', control: 'select', options: KIND_OPTIONS, default: 'ClusterComputeResource' },
      {
        id: 'formats',
        label: 'Formats',
        control: 'select',
        options: [
          { value: 'both', label: 'PDF and CSV' },
          { value: 'pdf', label: 'PDF' },
          { value: 'csv', label: 'CSV' },
        ],
        default: 'both',
      },
      {
        id: 'cadence',
        label: 'How often',
        control: 'select',
        options: [
          { value: 'weekly', label: 'Weekly' },
          { value: 'monthly', label: 'Monthly' },
        ],
        default: 'monthly',
      },
      { id: 'recipients', label: 'Send to', control: 'text', default: 'platform-team@example.com' },
      { id: 'start_hour', label: 'Hour (GMT)', control: 'number', default: 7, min: 0, max: 23 },
    ],
    automation: (values                 , name        )             => {
      const reportName = str(values, 'report_name', 'Report');
      const views = str(values, 'views', '').split('\n').map((line) => line.trim()).filter(Boolean);
      const kind = str(values, 'kind', 'ClusterComputeResource');
      const formats = str(values, 'formats', 'both');
      const cadence = str(values, 'cadence', 'monthly');
      const recipients = listOf(str(values, 'recipients', ''));
      const hour = num(values, 'start_hour', 7);
      const base = slugOf(name || reportName, 'report');
      const reportId = stableId(`report:${reportName}`);

      const findings            = [];
      if (views.length === 0) findings.push(error('vcfops.report.no-views', 'A report with no views is a cover page.', { source: SRC }));
      if (recipients.length === 0) findings.push(error('vcfops.report.no-recipient', 'No recipients, so the schedule generates a report nobody receives.', { source: SRC }));
      if (views.length > 8) findings.push(warning('vcfops.report.long', `${views.length} views in one report.`, { remediation: 'Nobody reads past page ten. Split it by audience.', source: SRC }));

      const formatList = formats === 'both' ? ['PDF', 'CSV'] : [formats.toUpperCase()];
      // As a Reports → Export writes it (sentania-labs, VCF Operations 9): ReportDef
      // with isTenant, Title, Description, SubjectType, Sections of
      // ContentType/ContentKey (a view section's key is the view id) and Settings.
      const reportXml = [
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
        '<Content>',
        '    <Reports>',
        `        <ReportDef id="${reportId}">`,
        '            <isTenant>false</isTenant>',
        `            <Title>${xml(reportName)}</Title>`,
        `            <Description>Generated by ArchToolKit: ${xml(views.join(', '))}.</Description>`,
        `            <SubjectType adapterKind="VMWARE" resourceKind="${xml(kind)}" type="self"/>`,
        '            <Sections>',
        '                <Section>',
        '                    <ContentType>CoverPage</ContentType>',
        '                    <ContentKey>COVER_PAGE</ContentKey>',
        '                </Section>',
        '                <Section>',
        '                    <ContentType>TableOfContents</ContentType>',
        '                    <ContentKey>TABLE_OF_CONTENTS</ContentKey>',
        '                </Section>',
        ...views.flatMap((view) => [
          '                <Section>',
          '                    <ContentType>View</ContentType>',
          `                    <ContentKey>${viewIdOf(view)}</ContentKey>`,
          '                    <ContentOrientation>Landscape</ContentOrientation>',
          '                </Section>',
        ]),
        '            </Sections>',
        '            <Settings>',
        '                <ShowPageFooter>true</ShowPageFooter>',
        ...formatList.map((format) => `                <OutputFormat>${format.toLowerCase()}</OutputFormat>`),
        '            </Settings>',
        '        </ReportDef>',
        '    </Reports>',
        '</Content>',
        '',
      ].join('\n');

      const schedule = {
        reportDefinitionId: '<set by schedule-report.sh>',
        resourceId: ['<set by schedule-report.sh from RESOURCE_ID>'],
        reportScheduleType: cadence === 'weekly' ? 'WEEKLY' : 'MONTHLY',
        recurrence: 1,
        ...(cadence === 'weekly' ? { daysOfTheWeek: ['MONDAY'] } : {}),
        dayOfTheMonth: 1,
        startDate: '<REQUIRED — the first date it may run, e.g. 2026-10-01; check the format against GET of an existing schedule>',
        startHour: hour,
        startMinute: 0,
        emailAddresses: recipients,
        relativePath: [],
      };

      const scheduleScript = [
        '#!/usr/bin/env bash',
        `# Schedule the report "${reportName}" once it has been imported.`,
        '#',
        '# Schedules made through the API run in GMT unless VCFOPS_TIMEZONE is set (sent',
        '# as the X-Ops-API-Timezone header, e.g. Europe/London). Without --execute this',
        '# only prints the body. Not idempotent: a second run makes a second schedule —',
        '# the Orchestrator workflow checks for an existing one first.',
        'set -euo pipefail',
        'cd "$(dirname "$0")"',
        '',
        ...authPreamble(PLATFORM),
        `: "\${RESOURCE_ID:?set RESOURCE_ID to the id of the ${kind} to run it for: GET /suite-api/api/resources?resourceKind=${kind}&name=...}"`,
        'command -v jq >/dev/null || { echo "jq is required" >&2; exit 2; }',
        '',
        '# Find the imported definition by name rather than trusting the id in the XML:',
        '# an import may assign its own.',
        `DEF_ID=$(curl -sS -f -G "https://\${VCFOPS_HOST}/suite-api/api/reportdefinitions" --data-urlencode 'name=${sq(reportName)}' -H "${authHeader(PLATFORM)}" -H "Accept: application/json" \\`,
        `  | jq -r --arg n '${sq(reportName)}' '[.reportDefinitions[]? | select(.name == $n) | .id] | if length == 1 then .[0] else empty end')`,
        `[[ -n "$DEF_ID" ]] || { echo "Expected exactly one report definition named '${sq(reportName)}'. Import it first, or remove the duplicate." >&2; exit 2; }`,
        '',
        `body=$(jq --arg d "$DEF_ID" --arg r "$RESOURCE_ID" '.reportDefinitionId = $d | .resourceId = [$r]' ${base}-schedule.json)`,
        'if grep -q "<REQUIRED" <<<"$body"; then',
        `  echo "${base}-schedule.json still has a <REQUIRED> value in it. Fill it in first." >&2`,
        '  exit 2',
        'fi',
        'path="/suite-api/api/reportdefinitions/${DEF_ID}/schedules"',
        'if [[ "${1:-}" != "--execute" ]]; then',
        '  echo "DRY RUN: would POST to https://${VCFOPS_HOST}${path}:"',
        '  echo "$body"',
        '  exit 0',
        'fi',
        'TZ_HEADER=()',
        '[[ -n "${VCFOPS_TIMEZONE:-}" ]] && TZ_HEADER=(-H "X-Ops-API-Timezone: ${VCFOPS_TIMEZONE}")',
        `echo "$body" | curl -sS -f -X POST "https://\${VCFOPS_HOST}\${path}" -H "${authHeader(PLATFORM)}" "\${TZ_HEADER[@]}" -H "Accept: application/json" -H "Content-Type: application/json" --data @-`,
        'echo',
        '# Undo: GET ${path}, then DELETE ${path}/{scheduleId}.',
        '',
      ].join('\n');

      const packageName = packageNameOf('vcfops', 'report', base);
      const what = `the report "${reportName}"`;
      const reportWorkflow = String.raw`var REPORT_NAME = ${JSON.stringify(reportName)};
var KIND = ${JSON.stringify(kind)};
var ctx = core.begin(settings, dryRun);
${OPS_LOGIN}
var api = "https://" + settings.opsHost + "/suite-api/api/";
// Every page is read; a list that cannot be read whole is an error, never an
// empty list (acting on "nothing exists" would create duplicates).
function listAll(path, key) {
  return core.pageAll(function (page) {
    var r = core.http("GET", api + path + (path.indexOf("?") < 0 ? "?" : "&") + "page=" + page + "&pageSize=1000", auth, null, SAFE).body;
    if (!r || typeof r !== "object" || (!r.hasOwnProperty(key) && !r.pageInfo)) throw new Error("GET " + path.split("?")[0] + " returned no " + key + " (VERIFY the response shape on your release); refusing to go on with an empty list.");
    var total = r.pageInfo && r.pageInfo.totalCount !== undefined && r.pageInfo.totalCount !== null ? r.pageInfo.totalCount : null;
    return { items: r[key] || [], total: total, more: r.pageInfo ? null : false };
  }, 0);
}
var result = null;
var scheduleId = "";
try {
  var schedule = JSON.parse(core.resource(RESOURCE_PATH, "schedule.json"));
  if (settings.startDate) schedule.startDate = String(settings.startDate);
  if (/<REQUIRED/.test(String(schedule.startDate))) throw new Error("Set startDate in the configuration element " + SETTINGS_NAME + ": the first date the schedule may run, in the format GET of an existing schedule shows.");
  // The object the report runs for: resourceId, or exactly one object of the kind by name.
  var resourceId = settings.resourceId ? String(settings.resourceId) : "";
  if (!resourceId) {
    if (!settings.resourceName) throw new Error("Set resourceName (or resourceId) in the configuration element " + SETTINGS_NAME + ": the " + KIND + " the report runs for.");
    var found = listAll("resources?resourceKind=" + encodeURIComponent(KIND) + "&name=" + encodeURIComponent(settings.resourceName), "resourceList");
    var exact = [];
    for (var i = 0; i < found.length; i++) if (found[i].resourceKey && String(found[i].resourceKey.name) === String(settings.resourceName)) exact.push(found[i]);
    if (exact.length !== 1) throw new Error("Expected exactly one " + KIND + " named '" + settings.resourceName + "', found " + exact.length + ". Set resourceId instead.");
    resourceId = String(exact[0].identifier);
  }
  result = mod.contentImport(ctx, settings.opsHost, auth, settings._secrets, {
    contentType: "REPORT_DEFINITIONS",
    what: ${JSON.stringify(what)},
    overwrite: settings.overwrite,
    build: function (ownerId, userName) {
      var inner = mod.zipStored([{ name: "content.xml", data: mod.ascii(core.resource(RESOURCE_PATH, "report-content.xml"), "xml"), pad: "text" }]);
      return { entries: [
        { name: "reports.zip", data: inner, pad: "zip" },
        { name: "configuration.json", data: JSON.stringify({ reports: 1, type: "CUSTOM" }), pad: "text" }
      ] };
    }
  });
  if (result && result.imported === 0) System.log("Already in VCF Operations: the import skipped the report definition (force=false) and left it as it is. Set overwrite to true to replace it.");

  // Find the definition by name rather than trusting the id in the XML: an import may assign its own.
  var defs = listAll("reportdefinitions?name=" + encodeURIComponent(REPORT_NAME), "reportDefinitions");
  var same = [];
  for (var d = 0; d < defs.length; d++) if (String(defs[d].name) === REPORT_NAME) same.push(defs[d]);
  if (same.length > 1) throw new Error(same.length + " report definitions are named '" + REPORT_NAME + "'. Scheduling the older one sends the wrong report; remove the duplicate first.");
  if (same.length === 0) {
    if (!ctx.dryRun) throw new Error("No report definition named '" + REPORT_NAME + "' after the import. Check Reports > Manage.");
    core.act(ctx, "schedule the report \"" + REPORT_NAME + "\" for " + resourceId + " once it is imported", function () { return null; });
  } else {
    var defId = String(same[0].id);
    var listed = core.http("GET", api + "reportdefinitions/" + defId + "/schedules", auth, null, SAFE).body;
    var existing = null;
    if (listed && typeof listed === "object") {
      var wrappers = [listed, listed.reportSchedules, listed.schedules, listed.reportSchedule];
      for (var w = 0; w < wrappers.length && existing === null; w++) if (wrappers[w] && typeof wrappers[w] === "object" && typeof wrappers[w] !== "string" && wrappers[w].length !== undefined) existing = wrappers[w];
    }
    // An unrecognised shape is not "no schedules": reading it as one would add a second schedule.
    if (existing === null) throw new Error("GET reportdefinitions/" + defId + "/schedules returned no list this workflow recognises (reportSchedules, schedules or reportSchedule); refusing to act on it. VERIFY the response shape on your release.");
    var mine = null;
    for (var s = 0; s < existing.length; s++) {
      // resourceId is a list in the documented schedule, but take a single id too.
      var on = existing[s].resourceId;
      if (on === null || on === undefined) on = [];
      else if (typeof on !== "object") on = [on];
      for (var o = 0; o < on.length; o++) if (String(on[o]) === resourceId) mine = existing[s];
    }
    if (mine) {
      scheduleId = String(mine.id || "");
      System.log("Exists, left as it is: a schedule of '" + REPORT_NAME + "' for " + resourceId + " (" + scheduleId + ")");
    } else {
      schedule.reportDefinitionId = defId;
      schedule.resourceId = [resourceId];
      if (settings.emailPluginId) schedule.emailPluginId = String(settings.emailPluginId);
      var headers = {};
      for (var h in auth) if (auth.hasOwnProperty(h)) headers[h] = auth[h];
      if (settings.timezone) headers["X-Ops-API-Timezone"] = String(settings.timezone);
      var created = core.act(ctx, "schedule the report \"" + REPORT_NAME + "\" (" + schedule.reportScheduleType + ") for " + resourceId, function () {
        var r = core.http("POST", api + "reportdefinitions/" + defId + "/schedules", headers, schedule, SAFE);
        if (!r.body || !r.body.id) throw new Error("POST reportdefinitions/" + defId + "/schedules returned no id.");
        return String(r.body.id);
      });
      scheduleId = created || "";
    }
  }
} finally {
  core.logoutVcfOps(settings.opsHost, auth);
}
importId = result ? result.id : "";
summary = core.audit(ctx, { what: ${JSON.stringify(what)}, importId: importId, scheduleId: scheduleId, resourceId: resourceId });
core.notify(settings.webhook, summary);`;
      const pkg = toPackage({
        packageName,
        description: `Imports the VCF Operations report definition "${reportName}" and schedules it for one ${kind}. Generated by ArchToolKit.`,
        categoryPath: `ArchToolKit/VCF Operations/${base}`,
        workflow: {
          name: `Import and schedule report ${base}`,
          description: `Imports the report definition "${reportName}" through Content Management (force=false unless overwrite), then finds it by name and creates its ${cadence} schedule for the ${kind} in the settings, unless that object already has one. A dry run until dryRun is set to false in the configuration element.`,
          inputs: [{ name: 'dryRun', type: 'boolean', description: 'true: read and report what would change, change nothing' }],
          outputs: [
            { name: 'importId', type: 'string', description: 'The Content Management import id, empty in a dry run' },
            { name: 'scheduleId', type: 'string', description: 'The schedule id, created or found; empty in a dry run' },
            { name: 'summary', type: 'string', description: 'The audit record, JSON' },
          ],
          script: reportWorkflow,
        },
        actions: contentActions(packageName),
        config: {
          name: 'Settings',
          description: `Settings of the Import and schedule report ${base} workflow. Fill opsPassword, resourceName (or resourceId) and startDate after import; set dryRun to false only after a dry run.`,
          attributes: contentAttributes(2, [
            { name: 'resourceName', type: 'string', value: '', description: `The ${kind} the report runs for, by name (exactly one must match)` },
            { name: 'resourceId', type: 'string', value: '', description: 'Or its id, which wins over resourceName' },
            { name: 'startDate', type: 'string', value: '', description: 'The first date the schedule may run; VERIFY the format against GET of an existing schedule' },
            { name: 'timezone', type: 'string', value: '', description: 'Time zone of startHour (X-Ops-API-Timezone, e.g. Europe/London); empty = GMT' },
            { name: 'emailPluginId', type: 'string', value: '', description: 'Optional: the outbound mail plugin instance to send with; empty = the default' },
          ]),
        },
        resources: [
          { name: 'report-content.xml', content: reportXml, mimeType: 'application/xml' },
          { name: 'schedule.json', content: `${JSON.stringify(schedule, null, 2)}\n` },
        ],
      });

      return {
        platform: PLATFORM,
        title: `Report "${reportName}" — ${views.length} views, ${formatList.join(' and ')}, ${cadence}`,
        effect: 'reversible',
        trigger: { kind: 'schedule', detail: `${cadence === 'weekly' ? 'Every Monday' : 'The first of each month'} at ${String(hour).padStart(2, '0')}:00 — GMT unless the schedule is created with a time zone (X-Ops-API-Timezone)`, worstCase: cadence === 'weekly' ? 'once a week' : 'once a month' },
        scope: {
          what: `The report definition "${reportName}", run for one ${kind} (resourceName or resourceId in the workflow settings; RESOURCE_ID for the script), mailed to ${recipients.join(', ') || 'nobody'}.`,
          decidedBy: ['The views in it, in order.', `The object it is scheduled for — one per schedule; the views run against its descendants.`, 'The mail plugin that sends it.'],
          ifWrong: 'A report about the wrong object that looks plausible, mailed monthly and acted on.',
        },
        guardrails: [
          { rule: 'The workflow and schedule-report.sh refuse unless exactly one definition has this name, and the workflow refuses unless exactly one object of the kind has the name in resourceName', because: 'Scheduling the older of two same-named reports sends last year’s columns to people who will not notice.' },
          { rule: `The workflow Import and schedule report ${base} leaves an existing schedule of this report for the same object alone, is a dry run until dryRun is false, and makes at most cap (2) changes: the import and the schedule`, because: 'The schedule API is not idempotent: a second POST is a second schedule, and the report arrives twice.' },
          { rule: 'The workflow and both scripts stop on <REQUIRED>', because: 'A schedule with a placeholder start date is rejected at best and misfires at worst.' },
          { rule: 'Dry run by default for the import and the schedule', because: 'The content-zip layout comes from real exports rather than a published specification; compare it with an export-reference.sh export before sending.' },
          { rule: 'With --execute, the script first exports the existing REPORT_DEFINITIONS content to pre-import-backup-<time>.zip and refuses to import when a report with the same name or id is already there, unless --overwrite is given', because: 'The import API overwrites by default (force defaults to true), and somebody’s hand-edited copy would be gone with no copy kept.' },
          { rule: 'The import is sent with force=false unless --overwrite (overwrite in the workflow settings)', because: 'Without it the API replaces whatever matches, which is the documented default.' },
          { rule: 'The script and the workflow follow the import by the id its POST returned and fail unless it reaches FINISHED with nothing failed, or when it times out', because: 'Reading the "last import" status can show an earlier import, and a FAILED import that exits 0 is taken as done.' },
        ],
        dryRun: [`Run the workflow Import and schedule report ${base} with dryRun = true: it resolves the object, lists the package and logs "DRY RUN: would import …" and "DRY RUN: would schedule …".`, 'Or run import-report.sh and scripts/schedule-report.sh without --execute.', 'After importing, run the report once by hand against the same object and read it before scheduling.'],
        undo: [
          'GET /suite-api/api/reportdefinitions/{id}/schedules, then DELETE /suite-api/api/reportdefinitions/{id}/schedules/{scheduleId} (the workflow\'s scheduleId output and AUDIT lines name it).',
          'Delete the report definition under Reports > Manage.',
          'If --overwrite (or overwrite in the workflow settings) replaced a report definition, import the backup export — the pre-import-backup-<time>.zip the script wrote, or the export the workflow made just before its import — to put the previous one back.',
        ],
        told: recipients.length > 0 ? [`${recipients.join(', ')}, ${cadence}.`] : ['Nobody.'],
        requires: [
          `The views (${views.join(', ') || 'none'}) imported first, from "A view for dashboards and reports" with the same names.`,
          'An outbound mail plugin that works: send a test from it first.',
          'zip, unzip, jq and curl for the scripts.',
          'For the package: VCF Automation 9.1 (or VCF Operations orchestrator 9.1) with the VCF Operations certificate trusted in Orchestrator.',
        ],
        files: {
          ...pkg.files,
          'import/report.zip/content.xml': reportXml,
          'import/report.xml': reportXml,
          ...contentPackage({ 'reports.zip/content.xml': reportXml }, { reports: 1 }),
          [`scripts/${base}-schedule.json`]: `${JSON.stringify(schedule, null, 2)}\n`,
          'import-report.sh': contentImportScript({ what: `the report "${reportName}"`, contentType: 'REPORT_DEFINITIONS', needles: [`<Title>${xml(reportName)}</Title>`, reportId] }),
          'scripts/schedule-report.sh': scheduleScript,
          'export-reference.sh': exportReferenceScript('REPORT_DEFINITIONS'),
          'IMPORT.md': importMd({
            title: `the report "${reportName}"`,
            steps: [
              ...packageSteps(pkg, 'imports and schedules the report'),
              {
                heading: 'Before the first live run: its views, and the settings',
                files: [],
                how: [
                  `Import the views it is made of before the report: ${views.join(', ') || '(none)'} — each from "A view for dashboards and reports" with the same name (its own package, or its import/view.zip). A report section refers to its view by id, and a report whose views are missing does not import.`,
                  `In the configuration element set resourceName (or resourceId), the ${kind} it runs for; startDate; and timezone if the start hour is not GMT.`,
                ],
              },
              {
                heading: 'How the workflow does it',
                files: [],
                how: [
                  `Reads GET /suite-api/api/resources?resourceKind=${kind}&name=… (exactly one match), GET /suite-api/api/auth/currentuser and GET …/content/operations/import; imports through Content Management as one guarded change (POST …/content/operations/export for the backup and the <number>L.v1 marker, POST …/import?force=false with reports.zip, GET …/import until FINISHED); then GET /suite-api/api/reportdefinitions?name=… (exactly one), GET …/reportdefinitions/{id}/schedules, and — only when no schedule of it exists for the object — POST …/reportdefinitions/{id}/schedules as the second guarded change, with X-Ops-API-Timezone when timezone is set.`,
                ],
                verify: [
                  'the list key of GET …/reportdefinitions/{id}/schedules: the workflow reads reportSchedules (or schedules); if your release answers with another key it finds no existing schedule and makes a second one. Check the first live run\'s log.',
                  'startDate\'s format: the API reference types it only as a string.',
                  'the zip is sent through the REST plugin as a string, built so every byte is below 0x80 except possibly the marker file\'s CRC (the upload declares charset=ISO-8859-1). If the import reports the package unreadable, use import-report.sh.',
                ],
              },
              {
                heading: 'Or: the report definition by hand',
                files: ['import/report.zip'],
                how: ['Reports → Manage → ⋯ → Import (8.x: Dashboards → Reports → Import), and choose import/report.zip — a zip holding content.xml, as a report export is.', 'If a view it names already exists and the dialog asks, choose to overwrite only if the view here is the newer one.'],
                verify: ['import/report.xml is the same content.xml as a bare file, for dialogs that take the XML on its own.'],
              },
              contentStep('REPORT_DEFINITIONS', 'import-report.sh'),
              {
                heading: 'Then the schedule, by script',
                files: [`scripts/${base}-schedule.json`, 'scripts/schedule-report.sh'],
                how: [`RESOURCE_ID=<id of the ${kind}> ./scripts/schedule-report.sh --execute — POST /suite-api/api/reportdefinitions/{id}/schedules (VCFOPS_TIMEZONE sets X-Ops-API-Timezone). Or in the interface: the report's Schedule action.`],
              },
            ],
            sources: FORMAT_SOURCES,
          }),
        },
        notes: [
          CONTENT_IMPORT_NOTE,
          'Formats are set on the report definition, not the schedule. The schedule body is the one used by "Email a capacity report on a schedule".',
          'CONFIRMED in the VCF Operations API reference (developer.broadcom.com, Reports): GET /api/reportdefinitions takes name, subject, owner, page and pageSize and answers reportDefinitions[] with pageInfo; POST /api/reportdefinitions/{id}/schedules takes reportDefinitionId, resourceId[], reportScheduleType (DAILY, WEEKLY, MONTHLY, YEARLY), recurrence, dayOfTheMonth, daysOfTheWeek, startDate, startHour, startMinute, emailAddresses, emailPluginId and relativePath, with an optional X-Ops-API-Timezone header. VERIFY: the name field of each listed definition (the workflow and the script match on it and refuse rather than guess).',
        ],
        findings,
      };
    },
  }),
  // -------------------------------------------------------------------------
  automationBlueprint({
    id: 'vcfops_management_pack',
    platform: PLATFORM,
    label: 'Install or upgrade a management pack',
    group: 'Extend',
    description:
      'A management pack (.pak) checked before it goes anywhere near the cluster: its manifest read for its version and the minimum VCF Operations it needs, compared with what is running and with what is installed, and refused if it would be a downgrade. Then uploaded and installed through the cluster admin (CASA) API, with a change ticket required, and an account configured afterwards.',
    inputs: [
      { id: 'pak_file', label: '.pak file', control: 'text', default: 'vmware-mpforhcx-9.1.0.pak', hint: 'Beside the script, as downloaded from the Broadcom support portal or the Marketplace' },
      { id: 'solution_name', label: 'Solution name as listed', control: 'text', default: 'VMware HCX', hint: 'For display only: the installed pack is matched by the adapter kinds in the pak’s manifest' },
      {
        id: 'mode',
        label: 'This is',
        control: 'select',
        options: [
          { value: 'install', label: 'A new install' },
          { value: 'upgrade', label: 'An upgrade of an installed pack' },
        ],
        default: 'install',
      },
      { id: 'configure_account', label: 'Configure an account afterwards', control: 'toggle', default: true },
      { id: 'adapter_kind', label: 'Adapter kind', control: 'text', default: '<REQUIRED — adapter kind key from GET /suite-api/api/solutions/{id}/adapterkinds after install>', showWhen: { input: 'configure_account', equals: ['true'] } },
      { id: 'account_host', label: 'Account target host', control: 'text', default: 'hcx-mgr01.example.com', showWhen: { input: 'configure_account', equals: ['true'] } },
    ],
    automation: (values                 , name        )             => {
      const pak = str(values, 'pak_file', 'management-pack.pak');
      const solution = str(values, 'solution_name', '');
      const mode = str(values, 'mode', 'install');
      const configure = bool(values, 'configure_account', true);
      const adapterKind = str(values, 'adapter_kind', '');
      const host = str(values, 'account_host', '');
      const base = slugOf(name || pak.replace(/\.pak$/i, ''), 'management-pack');

      const findings            = [];
      if (!/\.pak$/i.test(pak)) findings.push(error('vcfops.mp.not-pak', `${pak} does not end in .pak. Management packs are uploaded as .pak files.`, { source: SRC }));
      if (!solution) findings.push(info('vcfops.mp.no-solution', 'No solution name: the precheck matches the installed pack by the pak’s adapter kinds anyway; the name is only used to say when the listing calls it something else.', { source: SRC }));

      const precheck = readScript(PLATFORM, `Precheck ${pak} against the running VCF Operations. Changes nothing. Pass --upgrade when replacing an installed pack.`, [
        '# The .pak is read beside this script.',
        'cd "$(dirname "$0")"',
        ...workDirLines(PLATFORM),
        `PAK='${sq(pak)}'`,
        'UPGRADE=0',
        '[[ "${1:-}" == "--upgrade" ]] && UPGRADE=1',
        '[[ -f "$PAK" ]] || { echo "$PAK is not here" >&2; exit 2; }',
        'command -v unzip >/dev/null || { echo "unzip is required" >&2; exit 2; }',
        'PROBLEMS=0',
        '',
        '# A .pak is a zip with manifest.txt (JSON) at the top. VERIFY the field names',
        '# on your pak: `unzip -p file.pak manifest.txt | jq .`',
        'MANIFEST=$(unzip -p "$PAK" manifest.txt 2>/dev/null) || { echo "No manifest.txt in $PAK: is it really a management pack?" >&2; exit 2; }',
        'jq -e . >/dev/null <<<"$MANIFEST" || { echo "manifest.txt in $PAK is not JSON." >&2; exit 2; }',
        "PAK_VERSION=$(jq -r '.version // empty' <<<\"$MANIFEST\")",
        "PAK_MIN=$(jq -r '.vcops_minimum_version // .platform_minimum_version // empty' <<<\"$MANIFEST\")",
        "PAK_NAME=$(jq -r '.name // .display_name // empty' <<<\"$MANIFEST\")",
        '# The pack is identified by what it installs — its adapter kinds — not by a',
        '# display name, which differs between the manifest, the listing and releases.',
        "PAK_KINDS=$(jq -c '[(.adapter_kinds // .adapterKinds // [])[] | ascii_downcase] | unique' <<<\"$MANIFEST\")",
        'echo "pak:        ${PAK_NAME:-?} ${PAK_VERSION:-?}, adapter kinds ${PAK_KINDS}, needs VCF Operations ${PAK_MIN:-(not stated)}"',
        'if [[ "$PAK_KINDS" == "[]" ]]; then',
        '  echo "PROBLEM: the manifest names no adapter kinds, so the precheck cannot tell whether this pack is already installed. Read manifest.txt and check Integrations > Repository by hand." >&2',
        '  PROBLEMS=1',
        'fi',
        '',
        "OPS=$(get /suite-api/api/versions/current | jq -r '.releaseName // (\"\\(.major).\\(.minor).\\(.minorMinor // 0)\")')",
        'OPS_NUM=$(grep -oE "[0-9]+(\\.[0-9]+)+" <<<"$OPS" | head -1 || true)',
        'echo "running:    VCF Operations ${OPS} (${OPS_NUM:-?})"',
        '[[ -n "$OPS_NUM" ]] || { echo "PROBLEM: could not read the running version." >&2; PROBLEMS=1; }',
        'newer() { [[ "$(printf "%s\\n%s\\n" "$1" "$2" | sort -V | tail -1)" == "$1" && "$1" != "$2" ]]; }',
        'if [[ -n "$PAK_MIN" && -n "$OPS_NUM" ]] && newer "$PAK_MIN" "$OPS_NUM"; then',
        '  echo "PROBLEM: the pak needs ${PAK_MIN}, this is ${OPS_NUM}." >&2; PROBLEMS=1',
        'fi',
        '[[ -z "$PAK_MIN" ]] && echo "The manifest states no minimum version: check the pack’s release notes for 9.1 support."',
        '',
        '# Installed solutions sharing an adapter kind with the pak (case-insensitive),',
        '# from GET /solutions: solution[] {id, name, version, adapterKindKeys}.',
        'get /suite-api/api/solutions > "$WORK/solutions.json"',
        'jq -e \'has("solution")\' "$WORK/solutions.json" >/dev/null || { echo "GET /solutions returned no solution list." >&2; exit 2; }',
        "SAME=$(jq -c --argjson k \"$PAK_KINDS\" '[.solution[] | select([(.adapterKindKeys // [])[] | ascii_downcase] as $s | any($k[]; . as $x | $s | index($x)))] | map({id, name, version})' \"$WORK/solutions.json\")",
        "N_SAME=$(jq length <<<\"$SAME\")",
        "INSTALLED=$(jq -r 'map(.version // empty) | first // empty' <<<\"$SAME\")",
        'echo "installed:  $(jq -r \'if length == 0 then "none with these adapter kinds" else map("\\(.name) (\\(.id)) \\(.version)") | join(", ") end\' <<<"$SAME")"',
        ...(solution ? [`jq -e --arg n '${sq(solution)}' 'any(.[]; (.name // "") | ascii_downcase == ($n | ascii_downcase))' <<<"$SAME" >/dev/null || [[ "$N_SAME" == 0 ]] || echo "Note: installed as a different name than '${sq(solution)}'; matched on adapter kind."`] : []),
        '(( N_SAME <= 1 )) || { echo "PROBLEM: ${N_SAME} installed solutions share an adapter kind with this pak. Resolve that by hand first." >&2; PROBLEMS=1; }',
        'if (( N_SAME > 0 && ! UPGRADE )); then',
        '  echo "PROBLEM: a solution with the same adapter kind is installed (${INSTALLED:-version unknown}). Installing would replace it (CLOBBER). Re-run with --upgrade if that is the intent." >&2; PROBLEMS=1',
        'fi',
        'if (( N_SAME == 0 && UPGRADE )); then',
        '  echo "PROBLEM: --upgrade was given, and nothing with these adapter kinds is installed." >&2; PROBLEMS=1',
        'fi',
        ...(mode === 'upgrade' ? ['(( UPGRADE )) || echo "This was generated as an upgrade: pass --upgrade." >&2'] : []),
        'if [[ -n "$INSTALLED" && -n "$PAK_VERSION" ]] && newer "$INSTALLED" "$PAK_VERSION"; then',
        '  echo "PROBLEM: ${PAK_VERSION} is older than the installed ${INSTALLED}. Management packs do not downgrade." >&2; PROBLEMS=1',
        'fi',
        'if [[ -n "$INSTALLED" && "$INSTALLED" == "$PAK_VERSION" ]]; then',
        '  echo "PROBLEM: ${PAK_VERSION} is already installed." >&2; PROBLEMS=1',
        'fi',
        'exit $PROBLEMS',
      ]);

      const install = [
        '#!/usr/bin/env bash',
        `# Upload and install ${pak} through the cluster admin (CASA) API.`,
        '#',
        '#   install.sh                       precheck, then stop',
        '#   install.sh --execute             a new install: refused if a solution with the',
        '#                                    same adapter kind is already installed',
        '#   install.sh --execute --upgrade   replace the installed pack (CLOBBER)',
        '#   install.sh --execute --upload-only  upload only, and print the pak id for the',
        '#                                    Orchestrator workflow (pakId in its settings),',
        '#                                    which then installs it',
        '#',
        '# Runs precheck.sh first and stops if it finds a problem. CHANGE_TICKET must be',
        '# set for --execute.',
        '#',
        '# CASA is the appliance admin API, not the public suite API: it takes basic',
        '# auth as the local admin, and the paths below are the ones used since',
        '# vROps 8 — VERIFY them on 9.1 before relying on this. The public suite API',
        '# lists installed solutions but has no install call.',
        'set -euo pipefail',
        '',
        'EXECUTE=0',
        'UPGRADE=0',
        'UPLOAD_ONLY=0',
        'for arg in "$@"; do',
        '  case "$arg" in',
        '    --execute) EXECUTE=1 ;;',
        '    --upgrade) UPGRADE=1 ;;',
        '    --upload-only) UPLOAD_ONLY=1 ;;',
        '    *) echo "Unknown argument $arg. Use --execute, --upgrade to replace an installed pack, --upload-only to stop after the upload." >&2; exit 2 ;;',
        '  esac',
        'done',
        ': "${VCFOPS_HOST:?set VCFOPS_HOST, e.g. vcfops.example.com}"',
        ': "${VCFOPS_ADMIN_USER:=admin}"',
        ': "${VCFOPS_ADMIN_PASSWORD_FILE:?set VCFOPS_ADMIN_PASSWORD_FILE to a file holding the admin password, mode 600}"',
        'command -v jq >/dev/null || { echo "jq is required" >&2; exit 2; }',
        'HERE=$(cd "$(dirname "$0")" && pwd)',
        '',
        'if (( UPGRADE )); then',
        '  (cd "$HERE" && bash ./precheck.sh --upgrade) || { echo "Precheck failed; nothing was uploaded." >&2; exit 2; }',
        'else',
        '  (cd "$HERE" && bash ./precheck.sh) || { echo "Precheck failed; nothing was uploaded." >&2; exit 2; }',
        'fi',
        '',
        'if (( ! EXECUTE )); then',
        `  echo "DRY RUN: precheck passed. Would upload ${sq(pak)} and $( (( UPGRADE )) && echo "upgrade (CLOBBER)" || echo "install") it."`,
        '  exit 0',
        'fi',
        ': "${CHANGE_TICKET:?set CHANGE_TICKET: a management pack install restarts collection and cannot be downgraded}"',
        '',
        '# The admin credential goes to curl as a config file on stdin, never as an argument.',
        'casa() {',
        '  { printf \'user = "%s:\' "$VCFOPS_ADMIN_USER"; tr -d \'\\n\' < "$VCFOPS_ADMIN_PASSWORD_FILE" | sed \'s/[\\\\"]/\\\\&/g\'; printf \'"\\n\'; } |',
        '    curl -sS -f -K - "$@"',
        '}',
        '',
        '# CLOBBER replaces an installed pack and is sent only with --upgrade, after the',
        '# precheck has confirmed a solution with the same adapter kind is installed.',
        '# Without it no pak_handling_advice is sent — VERIFY the default on your release.',
        'ADVICE=""',
        '(( UPGRADE )) && ADVICE="?pak_handling_advice=CLOBBER"',
        `echo "[$CHANGE_TICKET] uploading ${sq(pak)}"`,
        '# The multipart field is "file", as in William Lam\'s CASA example for VCF',
        '# Operations 9.x (williamlam.com, 2026-08, "Automating PAK Upload & Installation").',
        `PAK_ID=$(casa -X POST "https://\${VCFOPS_HOST}/casa/upgrade/cluster/pak/reserved/operation/upload\${ADVICE}" \\`,
        `  -H "Accept: application/json" -F "file=@$HERE/${sq(pak)}" | jq -r '.pak_id // empty')`,
        '[[ -n "$PAK_ID" ]] || { echo "Upload returned no pak_id." >&2; exit 2; }',
        'echo "pak_id ${PAK_ID}"',
        'echo "$PAK_ID" > "$HERE/pak-id.txt"',
        'if (( UPLOAD_ONLY )); then',
        '  echo "Uploaded, not installed. Set pakId to ${PAK_ID} in the Orchestrator workflow settings, or re-run without --upload-only."',
        '  exit 0',
        'fi',
        '',
        'casa -X POST "https://${VCFOPS_HOST}/casa/upgrade/cluster/pak/${PAK_ID}/operation/install" -H "Accept: application/json" -H "Content-Type: application/json" --data "{}" >/dev/null',
        'STATUS=""',
        'for _ in $(seq 1 90); do',
        '  STATUS=$(casa "https://${VCFOPS_HOST}/casa/upgrade/cluster/pak/${PAK_ID}/status" -H "Accept: application/json" | jq -r \'.cluster_pak_install_status // "?"\')',
        '  echo "$(date +%T) ${STATUS}"',
        '  case "$STATUS" in COMPLETED) break ;; FAILED|*ERROR*) echo "Install failed: read the Administration > Integrations > Repository page." >&2; exit 1 ;; esac',
        '  sleep 20',
        'done',
        '[[ "$STATUS" == COMPLETED ]] || { echo "Still ${STATUS} after 30 minutes; check the interface before running anything else." >&2; exit 1; }',
        `echo "[$CHANGE_TICKET] $( (( UPGRADE )) && echo upgrade || echo install ) complete."`,
        '',
      ].join('\n');

      const account = {
        name: `${host || 'target'} (ArchToolKit)`,
        description: 'Generated by ArchToolKit.',
        adapterKindKey: adapterKind,
        collectorId: '<REQUIRED — collector or collector group id: GET /suite-api/api/collectors>',
        resourceIdentifiers: [{ name: '<REQUIRED — the host identifier name from GET /suite-api/api/adapterkinds/{adapterKind}/resourcekinds>', value: host }],
        credential: { id: '<REQUIRED — id of a credential created under Integrations > Credentials, never written here>' },
      };

      const packageName = packageNameOf('vcfops', 'mpack', base);
      const mpWorkflow = String.raw`var CONFIGURE = ${configure ? 'true' : 'false'};
var ctx = core.begin(settings, dryRun);
${OPS_LOGIN}
var api = "https://" + settings.opsHost + "/suite-api/api/";
var problems = [];
function problem(text) { problems.push(text); System.warn("PROBLEM: " + text); }
function parts(v) { var m = /[0-9]+(\.[0-9]+)*/.exec(String(v || "")); return m ? m[0].split(".") : null; }
// true when version a is later than version b, compared number by number.
function newer(a, b) {
  var x = parts(a), y = parts(b);
  if (!x || !y) return false;
  for (var i = 0; i < Math.max(x.length, y.length); i++) {
    var p = Number(x[i] || 0), q = Number(y[i] || 0);
    if (p !== q) return p > q;
  }
  return false;
}
var pakId = settings.pakId ? String(settings.pakId) : "";
var pakVersion = settings.pakVersion ? String(settings.pakVersion) : "";
var installedVersion = "";
var accountId = "";
try {
  // 1. The precheck: reads only, and nothing below runs unless it passes.
  var v = core.http("GET", api + "versions/current", auth, null, SAFE).body || {};
  var running = v.releaseName ? String(v.releaseName) : (v.major !== undefined && v.major !== null ? v.major + "." + v.minor + "." + (v.minorMinor || 0) : "");
  System.log("running: VCF Operations " + (running || "?"));
  if (!parts(running)) problem("could not read the running version from GET /suite-api/api/versions/current");
  if (!pakVersion) problem("pakVersion is empty: set it to the version in the pak's manifest.txt (scripts/precheck.sh prints it).");
  if (settings.pakMinimumVersion && parts(running) && newer(settings.pakMinimumVersion, running)) problem("the pak needs " + settings.pakMinimumVersion + ", this is " + running);
  var kinds = [];
  var given = settings.pakAdapterKinds || [];
  for (var k = 0; k < given.length; k++) if (given[k]) kinds.push(String(given[k]).toLowerCase());
  if (kinds.length === 0) problem("pakAdapterKinds is empty: without the pak's adapter kinds (manifest.txt adapter_kinds) nothing tells whether it is already installed.");
  var listed = core.http("GET", api + "solutions", auth, null, SAFE).body || {};
  if (!listed.solution) throw new Error("GET /suite-api/api/solutions returned no solution list; nothing was changed.");
  // The pack is identified by what it installs — its adapter kinds — not by a display name.
  var same = [];
  for (var s = 0; s < listed.solution.length; s++) {
    var keys = listed.solution[s].adapterKindKeys || [];
    for (var a = 0; a < keys.length; a++) {
      if (kinds.indexOf(String(keys[a]).toLowerCase()) >= 0) { same.push(listed.solution[s]); break; }
    }
  }
  var names = [];
  for (var n = 0; n < same.length; n++) names.push(same[n].name + " (" + same[n].id + ") " + same[n].version);
  System.log("installed: " + (names.length ? names.join(", ") : "none with these adapter kinds"));
  if (same.length > 1) problem(same.length + " installed solutions share an adapter kind with this pak. Resolve that by hand first.");
  installedVersion = same.length === 1 ? String(same[0].version || "") : "";
  var upgrade = settings.upgrade === true || String(settings.upgrade) === "true";
  var alreadyThere = pakVersion !== "" && installedVersion === pakVersion;
  if (alreadyThere) {
    System.log(pakVersion + " is already installed: nothing to install.");
  } else {
    if (same.length > 0 && !upgrade) problem("a solution with the same adapter kind is installed (" + (installedVersion || "version unknown") + "). Installing would replace it; set upgrade to true if that is the intent.");
    if (same.length === 0 && upgrade) problem("upgrade is set, and nothing with these adapter kinds is installed.");
    if (installedVersion && pakVersion && newer(installedVersion, pakVersion)) problem(pakVersion + " is older than the installed " + installedVersion + ". Management packs do not downgrade.");
  }
  if (problems.length > 0) throw new Error("Precheck failed, nothing was changed: " + problems.join("; "));
  System.log("Precheck passed.");

  // 2. The account, checked before any change so a live run stops before the install, not after.
  var account = CONFIGURE ? JSON.parse(core.resource(RESOURCE_PATH, "account.json")) : null;
  var accountReady = account !== null && !/<REQUIRED/.test(JSON.stringify(account));
  if (account !== null && !accountReady) {
    if (!ctx.dryRun) throw new Error("account.json still holds <REQUIRED> values (adapter kind, collector, identifier, credential id). Fill the resource element first; nothing was changed.");
    System.warn("The account would not be created: account.json still holds <REQUIRED> values.");
  }

  // 3. The install of a pak already uploaded (scripts/install.sh --upload-only or
  //    the interface): the REST plugin sends bodies as text and cannot upload one.
  if (alreadyThere) {
    // Nothing to do.
  } else if (!pakId) {
    System.log("No pakId in the settings: upload the .pak first (scripts/install.sh --execute --upload-only), then set pakId to the id it prints.");
  } else {
    if (!settings.changeTicket) throw new Error("Set changeTicket in the configuration element " + SETTINGS_NAME + ": a management pack install restarts collection and cannot be downgraded.");
    if (!settings.casaUsername || !settings.casaPassword) throw new Error("Set casaUsername and casaPassword (the cluster's local admin) in the configuration element " + SETTINGS_NAME + ".");
    var casa = { "Authorization": "Basic " + core.base64(String(settings.casaUsername) + ":" + String(settings.casaPassword)) };
    var casaApi = "https://" + settings.opsHost + "/casa/upgrade/cluster/pak/" + encodeURIComponent(pakId);
    var ticket = String(settings.changeTicket);
    core.act(ctx, "install management pack " + pakId + " [" + ticket + "]", function () {
      core.http("POST", casaApi + "/operation/install", casa, {}, SAFE);
      var state = "";
      for (var t = 0; t < 90; t++) {
        System.sleep(20000);
        var st = core.http("GET", casaApi + "/status", casa, null, SAFE).body || {};
        state = String(st.cluster_pak_install_status || "?");
        System.log("[" + ticket + "] " + state);
        if (state === "COMPLETED") return state;
        if (state === "FAILED" || state.indexOf("ERROR") >= 0) throw new Error("the install is " + state + ": read Administration > Integrations > Repository.");
      }
      throw new Error("still " + state + " after 30 minutes; check the interface before running anything else.");
    });
  }

  // 4. The account, unless one of that name exists for the adapter kind.
  if (accountReady) {
    var adapters = core.http("GET", api + "adapters?adapterKindKey=" + encodeURIComponent(account.adapterKindKey), auth, null, SAFE).body || {};
    var instances = adapters.adapterInstancesInfoDto || [];
    for (var i = 0; i < instances.length; i++) {
      if (instances[i].resourceKey && String(instances[i].resourceKey.name) === String(account.name)) accountId = String(instances[i].id);
    }
    if (accountId) {
      System.log("Exists, left as it is: the account \"" + account.name + "\" (" + accountId + ")");
    } else {
      accountId = core.act(ctx, "create the account \"" + account.name + "\"", function () {
        var r = core.http("POST", api + "adapters", auth, account, SAFE);
        if (!r.body || !r.body.id) throw new Error("POST /suite-api/api/adapters returned no id.");
        return String(r.body.id);
      }) || "";
    }
  }
} finally {
  core.logoutVcfOps(settings.opsHost, auth);
}
summary = core.audit(ctx, { pakId: pakId, pakVersion: pakVersion, installedBefore: installedVersion, accountId: accountId, problems: problems });
core.notify(settings.webhook, summary);`;
      const pkg = toPackage({
        packageName,
        description: `Prechecks ${pak} against the running VCF Operations, installs it once uploaded, and ${configure ? 'creates its account' : 'stops there'}. Generated by ArchToolKit.`,
        categoryPath: `ArchToolKit/VCF Operations/${base}`,
        workflow: {
          name: `Management pack ${base}`,
          description: `Prechecks ${pak} (running version, minimum version, installed solutions by adapter kind, downgrade) and stops on any problem; then installs the uploaded pak (pakId) through the cluster admin API under changeTicket${configure ? ', and creates its account unless one of that name exists' : ''}. A dry run until dryRun is set to false in the configuration element.`,
          inputs: [{ name: 'dryRun', type: 'boolean', description: 'true: precheck and report what would change, change nothing' }],
          outputs: [{ name: 'summary', type: 'string', description: 'The audit record, JSON' }],
          script: mpWorkflow,
        },
        config: {
          name: 'Settings',
          description: `Settings of the Management pack ${base} workflow. Fill the passwords, pakVersion and pakAdapterKinds (from the pak's manifest.txt) after import; pakId after the upload; set dryRun to false only after a dry run.`,
          attributes: [
            ...OPS_ATTRIBUTES,
            { name: 'casaUsername', type: 'string', value: 'admin', description: 'The cluster local admin, for the cluster admin (CASA) install call' },
            { name: 'casaPassword', type: 'SecureString', description: 'Its password' },
            { name: 'pakFile', type: 'string', value: pak, description: 'The .pak, for the log only' },
            { name: 'pakVersion', type: 'string', value: '', description: 'version in the pak\'s manifest.txt' },
            { name: 'pakMinimumVersion', type: 'string', value: '', description: 'vcops_minimum_version in manifest.txt; empty if it states none' },
            { name: 'pakAdapterKinds', type: 'Array/string', value: [], description: 'adapter_kinds in manifest.txt: how the installed pack is recognised' },
            { name: 'upgrade', type: 'boolean', value: mode === 'upgrade', description: 'true: replacing an installed pack with the same adapter kinds is the intent' },
            { name: 'pakId', type: 'string', value: '', description: 'The id the upload returned (scripts/install.sh --execute --upload-only); empty: precheck only' },
            { name: 'changeTicket', type: 'string', value: '', description: 'The change the install runs under; required to install' },
            { name: 'dryRun', type: 'boolean', value: true, description: 'The arming switch: nothing is installed or created while this is true' },
            { name: 'cap', type: 'number', value: configure ? 2 : 1, description: 'The most changes one run may make' },
            { name: 'webhook', type: 'SecureString', description: 'Optional: where the audit record is posted' },
          ],
        },
        resources: configure ? [{ name: 'account.json', content: `${JSON.stringify(account, null, 2)}\n` }] : [],
      });

      return {
        platform: PLATFORM,
        title: `${mode === 'upgrade' ? 'Upgrade' : 'Install'} ${pak}`,
        effect: 'irreversible',
        trigger: { kind: 'manual', detail: 'Run by an administrator, under the change named in CHANGE_TICKET (changeTicket in the workflow settings); never scheduled.', worstCase: 'once per change' },
        scope: {
          what: `The management pack in ${pak}, on every node of the VCF Operations cluster.`,
          decidedBy: ['The pak file itself.', 'The cluster: CASA distributes it to every node.', ...(configure ? [`The account for ${host}, created afterwards.`] : [])],
          ifWrong: 'A pack that does not support this release can stop its adapter collecting, or break content other packs depend on. There is no downgrade: the way back is uninstalling it (losing its history) or restoring the cluster from backup.',
        },
        guardrails: [
          { rule: 'precheck.sh runs first and install.sh stops if it exits non-zero; the workflow runs the same precheck and changes nothing when it finds a problem', because: 'Installing a pack built for an older platform is the usual cause of an adapter that stops collecting after an upgrade.' },
          { rule: 'The installed pack is found by the pak’s own adapter kinds (manifest.txt adapter_kinds, matched case-insensitively against adapterKindKeys in GET /solutions), not by display name; a manifest with no adapter kinds is a precheck failure', because: 'A display name that differs by one word ("VMware HCX" vs "HCX") made an installed pack look absent, and the upload then replaced it.' },
          { rule: 'Refuses to install over a solution with the same adapter kind unless --upgrade (upgrade in the workflow) is given, refuses --upgrade when none is installed, refuses a downgrade, leaves the same version alone, and sends CLOBBER only with --upgrade', because: 'CLOBBER replaces what is installed; a wrong file quietly rolls a pack back.' },
          { rule: 'Requires --execute and CHANGE_TICKET; the workflow requires dryRun false, changeTicket and a pakId, and makes at most cap changes', because: 'The install restarts collection across the cluster and cannot be undone by re-running anything; it belongs in a change window with a person who approved it.' },
          { rule: 'Admin password read from a mode-600 file and passed on stdin; in Orchestrator a SecureString, never logged', because: 'CASA takes the local admin credential; on a command line it would be in the process list of the jump host.' },
          ...(configure ? [{ rule: 'The account is created only when none of that name exists for the adapter kind, and not at all while account.json holds <REQUIRED>', because: 'A second adapter instance for the same target collects everything twice.' }] : []),
        ],
        dryRun: [
          `Run the workflow Management pack ${base} with dryRun = true: it runs the precheck and logs "DRY RUN: would install …"${configure ? ' and "DRY RUN: would create the account …"' : ''}.`,
          `Run scripts/precheck.sh${mode === 'upgrade' ? ' --upgrade' : ''} on its own: it only reads the pak and two GETs.`,
          `Run scripts/install.sh${mode === 'upgrade' ? ' --upgrade' : ''} without --execute: it runs the precheck and stops.`,
        ],
        undo: [
          'There is no downgrade. To go back: uninstall the pack under Administration > Integrations > Repository (its objects and history go with it), then install the previous .pak.',
          'Take a VCF Operations cluster backup (or snapshot, per your backup design) before an upgrade: that is the only full way back.',
          ...(configure ? ['The account: DELETE /suite-api/api/adapters/{id} with the id in the workflow\'s AUDIT line, or delete it under Integrations > Accounts.'] : []),
        ],
        told: ['The change ticket in CHANGE_TICKET (changeTicket), which every line install.sh and the workflow print carries.', 'Administration > Audit in VCF Operations records the install.', 'The webhook in the workflow settings, if set, gets the audit record.'],
        requires: [
          'The .pak beside the scripts (in scripts/), downloaded from the vendor with its checksum verified.',
          'The local admin account of the VCF Operations cluster, in VCFOPS_ADMIN_PASSWORD_FILE (casaPassword in the workflow).',
          'A suite API account for the precheck (VCFOPS_TOKEN or VCFOPS_USER/VCFOPS_PASSWORD_FILE; opsUsername/opsPassword in the workflow).',
          'jq, unzip, sort -V (GNU coreutils) and curl for the scripts.',
          'For the package: VCF Automation 9.1 (or VCF Operations orchestrator 9.1) with the VCF Operations certificate trusted in Orchestrator.',
        ],
        files: {
          ...pkg.files,
          'scripts/precheck.sh': precheck,
          'scripts/install.sh': install,
          ...(configure ? { [`${base}-account.json`]: `${JSON.stringify(account, null, 2)}\n` } : {}),
          'IMPORT.md': importMd({
            title: `the management pack ${pak}`,
            steps: [
              ...packageSteps(pkg, 'prechecks and installs the pack'),
              {
                heading: 'Upload the .pak, then install it from the workflow',
                files: [pak, 'scripts/install.sh'],
                how: [
                  `The Orchestrator REST plugin sends request bodies as text and cannot upload a .pak, so the upload is done by the script: put ${pak} in scripts/ and run CHANGE_TICKET=… ./scripts/install.sh --execute${mode === 'upgrade' ? ' --upgrade' : ''} --upload-only (POST /casa/upgrade/cluster/pak/reserved/operation/upload, multipart field file). It prints the pak id.`,
                  'Fill pakVersion, pakMinimumVersion and pakAdapterKinds from the pak\'s manifest.txt (./scripts/precheck.sh prints them), pakId, changeTicket and the passwords in the configuration element, run the workflow once as a dry run, then set dryRun to false. It prechecks again, then POST /casa/upgrade/cluster/pak/{pakId}/operation/install and GET …/status until COMPLETED' + (configure ? '; then GET /suite-api/api/adapters?adapterKindKey=… and POST /suite-api/api/adapters with account.json unless the account exists.' : '.'),
                ],
                verify: ['the cluster admin (CASA) calls are not in the public API reference — see the notes in README.md.'],
              },
              { heading: 'Or: check it and install it by script', files: ['scripts/precheck.sh', 'scripts/install.sh'], how: [`Put ${pak} beside the scripts (scripts/) and run ./scripts/precheck.sh. The .pak itself is the vendor's file, imported as it is; nothing here rewrites it.`, `CHANGE_TICKET=… ./scripts/install.sh --execute${mode === 'upgrade' ? ' --upgrade' : ''} uploads and installs it through the cluster admin API.`] },
              {
                heading: 'Or: install it in the interface',
                files: [pak],
                how: [`Administration → Integrations → Repository → Add (8.x: Data Sources → Integrations → Repository → Add), and choose ${pak}.`],
              },
              ...(configure ? [{ heading: 'Then its account, if not by the workflow', files: [`${base}-account.json`], how: ['POST /suite-api/api/adapters with this file (or "Add an adapter instance" in this kit, which also handles the credential and certificate), or Administration → Integrations → Accounts → Add Account.'], verify: ['credential {id} referring to an existing credential: the API reference\'s example creates a credential inline (name, adapterKindKey, credentialKindKey, fields) instead.'] }] : []),
            ],
          }),
        },
        notes: [
          'CONFIRMED: GET /suite-api/api/solutions, /solutions/{id} and /solutions/{id}/adapterkinds are the whole Solutions section of the VCF Operations API reference (developer.broadcom.com); they list, they do not install. The CASA upload/install/status paths are the ones William Lam uses for VCF Operations 9.x (williamlam.com, 2026-08, "Quick Tip: Automating PAK Upload & Installation for VCF Operations"), with the multipart field file (the script used contents before; corrected). VERIFY: the pak_id and cluster_pak_install_status response fields, which come from vROps 8.x usage.',
          'CONFIRMED: GET /solutions returns solution[] with id, name, version and adapterKindKeys. VERIFY: the manifest.txt field names (version, vcops_minimum_version, adapter_kinds) on your pak, and releaseName in GET /versions/current; the precheck prints what it found, and a manifest with no adapter kinds fails it.',
          `Run it as scripts/install.sh --execute${mode === 'upgrade' ? ' --upgrade' : ''} with CHANGE_TICKET set, or upload with --upload-only and install from the workflow.`,
          'In VCF 9.x the supported route is also the interface: Administration > Integrations > Repository > Add. If the CASA calls are refused, use that and keep the precheck as the gate.',
          ...(configure ? ['POST /suite-api/api/adapters (name, adapterKindKey, collectorId, resourceIdentifiers, credential) is in the 9.x API reference; the workflow finds an existing account in GET /suite-api/api/adapters?adapterKindKey= under adapterInstancesInfoDto[].resourceKey.name — VERIFY that list key on your release.'] : []),
        ],
        findings,
      };
    },
  }),

  // -------------------------------------------------------------------------
  automationBlueprint({
    id: 'vcfops_mp_builder',
    platform: PLATFORM,
    label: 'Design a Management Pack Builder pack (REST or Prometheus)',
    group: 'Extend',
    description:
      'The design a Management Pack Builder project needs before anyone opens the builder: the source (a REST API, or in 9.1 a Prometheus server), the object types, which response field or PromQL query becomes which metric, the relationships and the collection interval — plus a read-only test script that calls the source the way the pack will.',
    inputs: [
      {
        id: 'source',
        label: 'Source',
        control: 'select',
        options: [
          { value: 'rest', label: 'REST API' },
          { value: 'prometheus', label: 'Prometheus server (9.1)' },
        ],
        default: 'prometheus',
      },
      { id: 'base_url', label: 'Base URL', control: 'text', default: 'https://prometheus.example.com:9090' },
      {
        id: 'auth',
        label: 'Authentication',
        control: 'select',
        options: [
          { value: 'none', label: 'None' },
          { value: 'basic', label: 'Basic' },
          { value: 'bearer', label: 'Bearer token' },
        ],
        default: 'bearer',
      },
      { id: 'object_type', label: 'Object type', control: 'text', default: 'Kafka Broker' },
      { id: 'identifier', label: 'Identified by', control: 'text', default: 'instance', hint: 'A Prometheus label, or a field in each REST item' },
      { id: 'list_path', label: 'List request path', control: 'text', default: '/api/v1/brokers', showWhen: { input: 'source', equals: ['rest'] } },
      { id: 'items_path', label: 'Items in the response at', control: 'text', default: '.items', showWhen: { input: 'source', equals: ['rest'] } },
      {
        id: 'metrics',
        label: 'Metrics',
        control: 'textarea',
        default: 'Bytes in per sec = sum by (instance) (rate(kafka_server_brokertopicmetrics_bytesin_total[5m]))\nUnder-replicated partitions = sum by (instance) (kafka_server_replicamanager_underreplicatedpartitions)',
        hint: 'One per line: name = PromQL (Prometheus) or name = field path (REST)',
      },
      { id: 'relationships', label: 'Relationships', control: 'textarea', default: 'Kafka Broker -> VirtualMachine by name', hint: 'One per line: child -> parent by matching property' },
      { id: 'interval', label: 'Collection interval (minutes)', control: 'number', default: 5, min: 1, max: 1440 },
    ],
    automation: (values                 , name        )             => {
      const source = str(values, 'source', 'prometheus');
      const baseUrl = str(values, 'base_url', '').replace(/\/+$/, '');
      const auth = str(values, 'auth', 'none');
      const objectType = str(values, 'object_type', 'Object');
      const identifier = str(values, 'identifier', 'instance');
      const listPath = str(values, 'list_path', '/');
      const itemsPath = str(values, 'items_path', '.');
      const interval = num(values, 'interval', 5);
      const base = slugOf(name || objectType, 'mp-design');
      const metrics = str(values, 'metrics', '')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const at = line.indexOf('=');
          return at < 0 ? { name: line, expr: '' } : { name: line.slice(0, at).trim(), expr: line.slice(at + 1).trim() };
        });
      const relationships = str(values, 'relationships', '')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const m = /^(.+?)\s*->\s*(.+?)(?:\s+by\s+(.+))?$/.exec(line);
          return m ? { child: m[1] .trim(), parent: m[2] .trim(), match: (m[3] ?? '').trim() } : { child: line, parent: '', match: '' };
        });

      const findings            = [];
      if (metrics.length === 0) findings.push(error('vcfops.mpb.no-metrics', 'An object type with no metrics is an inventory entry and nothing else.', { source: SRC }));
      const noExpr = metrics.filter((metric) => !metric.expr);
      if (noExpr.length > 0) findings.push(error('vcfops.mpb.empty-metric', `No ${source === 'prometheus' ? 'query' : 'field'} for ${noExpr.map((m) => m.name).join(', ')}.`, { source: SRC }));
      if (!/^https?:\/\//.test(baseUrl)) findings.push(error('vcfops.mpb.url', `${baseUrl || 'The base URL'} is not an http(s) URL.`, { source: SRC }));
      if (baseUrl.startsWith('http://') && auth !== 'none') {
        findings.push(warning('vcfops.mpb.cleartext', 'Credentials over plain http.', { remediation: 'The pack sends them every collection cycle. Put the source behind TLS first.', source: SRC }));
      }
      if (interval < 5) findings.push(warning('vcfops.mpb.interval', `A ${interval}-minute interval is shorter than VCF Operations' own five-minute cycle.`, { remediation: 'Collections faster than the cycle are not stored any finer; they only load the source.', source: SRC }));
      if (source === 'prometheus') {
        const unaggregated = metrics.filter((metric) => metric.expr && !metric.expr.includes(identifier));
        if (unaggregated.length > 0) {
          findings.push(
            warning('vcfops.mpb.label', `${unaggregated.map((m) => m.name).join(', ')} do${unaggregated.length === 1 ? 'es' : ''} not mention the identifying label "${identifier}".`, {
              remediation: `Aggregate with "by (${identifier})" so each series maps to exactly one ${objectType}; otherwise one object receives many series, or none.`,
              source: SRC,
            }),
          );
        }
      }
      const orphans = relationships.filter((rel) => !rel.parent || !rel.match);
      if (orphans.length > 0) findings.push(warning('vcfops.mpb.relationship', `Relationship "${orphans.map((r) => r.child).join(', ')}" needs "child -> parent by property".`, { source: SRC }));

      const design = {
        generatedBy: 'ArchToolKit',
        note: 'A design worksheet for Management Pack Builder, not the builder’s own export format.',
        source: {
          type: source === 'prometheus' ? 'Prometheus' : 'REST',
          baseUrl,
          authentication: auth,
          credentialFrom: auth === 'none' ? null : 'Entered in the builder’s source settings; never stored in this file.',
        },
        objectTypes: [
          {
            name: objectType,
            identifier,
            ...(source === 'rest' ? { request: { method: 'GET', path: listPath, itemsAt: itemsPath } } : {}),
            metrics: metrics.map((metric) => (source === 'prometheus' ? { name: metric.name, promql: metric.expr } : { name: metric.name, field: metric.expr })),
          },
        ],
        relationships,
        collectionIntervalMinutes: interval,
      };

      const md = [
        `# ${objectType} — Management Pack Builder design`,
        '',
        `Source: ${source === 'prometheus' ? 'Prometheus server' : 'REST API'} at ${baseUrl}, auth ${auth}. Collected every ${interval} minutes.`,
        '',
        `## Object type: ${objectType}`,
        '',
        `Identified by \`${identifier}\`.${source === 'rest' ? ` Listed by GET \`${listPath}\`, items at \`${itemsPath}\`.` : ' One object per distinct value of that label across the queries below.'}`,
        '',
        '| Metric | ' + (source === 'prometheus' ? 'PromQL' : 'Field') + ' |',
        '|---|---|',
        ...metrics.map((metric) => `| ${metric.name} | \`${metric.expr.replace(/\|/g, '\\|')}\` |`),
        '',
        '## Relationships',
        '',
        ...(relationships.length > 0 ? relationships.map((rel) => `- ${rel.child} is a child of ${rel.parent || '?'}, matched on ${rel.match || '?'}`) : ['None.']),
        '',
        '## Building it',
        '',
        '1. Run test-source.sh and keep its output: those are the responses you will map.',
        '2. In VCF Operations, open Management Pack Builder and create a design with this source.',
        '3. Add the object type, the requests or queries, and the metrics above; set the identifier.',
        '4. Add the relationships, set the interval, run the builder’s own test, then build and install the .pak.',
        '',
      ].join('\n');

      const header = auth === 'bearer'
        ? ['  # The token goes to curl as a header on stdin, never as an argument.', '  printf "Authorization: Bearer %s\\n" "$(tr -d \'\\n\' < "$SOURCE_SECRET_FILE")" | curl -sS -f -H @- "$@"']
        : auth === 'basic'
          ? ['  # user:password goes to curl as a config file on stdin, never as an argument.', '  { printf \'user = "%s:\' "$SOURCE_USER"; tr -d \'\\n\' < "$SOURCE_SECRET_FILE"; printf \'"\\n\'; } | curl -sS -f -K - "$@"']
          : ['  curl -sS -f "$@"'];

      const test = [
        '#!/usr/bin/env bash',
        `# Call ${baseUrl} the way the pack will, and show what comes back. Reads only.`,
        '# Exits 1 if any request returns nothing to map.',
        'set -euo pipefail',
        'command -v jq >/dev/null || { echo "jq is required" >&2; exit 2; }',
        ...(auth !== 'none' ? [': "${SOURCE_SECRET_FILE:?set SOURCE_SECRET_FILE to a file holding the source credential, mode 600}"'] : []),
        ...(auth === 'basic' ? [': "${SOURCE_USER:?set SOURCE_USER}"'] : []),
        `BASE='${sq(baseUrl)}'`,
        'PROBLEMS=0',
        'call() {',
        ...header,
        '}',
        '',
        ...(source === 'prometheus'
          ? metrics.flatMap((metric) => [
              `echo "== ${metric.name.replace(/["$`\\]/g, '')}"`,
              `OUT=$(call -G "$BASE/api/v1/query" --data-urlencode 'query=${sq(metric.expr)}')`,
              `N=$(jq '.data.result | length' <<<"$OUT")`,
              `jq -r '.data.result[:5][] | "\\(.metric.${identifier.replace(/[^A-Za-z0-9_]/g, '_')} // "(no ${identifier.replace(/[^A-Za-z0-9_]/g, '_')} label)")  \\(.value[1])"' <<<"$OUT"`,
              'echo "${N} series"; (( N > 0 )) || PROBLEMS=1',
            ])
          : [
              `OUT=$(call "$BASE${listPath}")`,
              `N=$(jq '${itemsPath} | length' <<<"$OUT")`,
              `echo "${objectType.replace(/["$`\\]/g, '')}: \${N} item(s) at ${itemsPath}"`,
              `jq '${itemsPath}[0]' <<<"$OUT"`,
              '(( N > 0 )) || PROBLEMS=1',
              ...metrics.map((metric) => `jq -r '${itemsPath}[0] | ${metric.expr.startsWith('.') ? metric.expr : `.${metric.expr}`} // "MISSING"' <<<"$OUT" | sed 's/^/${metric.name.replace(/[/'&\\]/g, '')}: /'`),
            ]),
        'exit $PROBLEMS',
        '',
      ].join('\n');

      const packageName = packageNameOf('vcfops', 'mpb', base);
      const mpbWorkflow = String.raw`var SOURCE = ${JSON.stringify(source)};
var AUTH = ${JSON.stringify(auth)};
var IDENTIFIER = ${JSON.stringify(identifier)};
var design = JSON.parse(core.resource(RESOURCE_PATH, "design.json"));
var baseUrl = String(settings.sourceUrl || design.source.baseUrl || "").replace(/\/+$/, "");
if (!/^https?:\/\//.test(baseUrl)) throw new Error("Set sourceUrl (http or https) in the configuration element " + SETTINGS_NAME + ".");
var SAFE = { redact: settings._secrets };
var headers = null;
if (AUTH === "bearer") {
  if (!settings.sourceSecret) throw new Error("Set sourceSecret (the bearer token) in the configuration element " + SETTINGS_NAME + ".");
  headers = { "Authorization": "Bearer " + settings.sourceSecret };
}
if (AUTH === "basic") {
  if (!settings.sourceUser || !settings.sourceSecret) throw new Error("Set sourceUser and sourceSecret in the configuration element " + SETTINGS_NAME + ".");
  headers = { "Authorization": "Basic " + core.base64(String(settings.sourceUser) + ":" + String(settings.sourceSecret)) };
}
// A value at a path such as ".items", ".data.items[0].x" or "items".
function pick(value, path) {
  var p = String(path || "").replace(/^\./, "");
  if (!p) return value;
  var steps = p.split(".");
  for (var i = 0; i < steps.length; i++) {
    var m = /^([^\[]*)((\[[0-9]+\])*)$/.exec(steps[i]);
    if (!m) return undefined;
    if (m[1]) value = value === null || value === undefined ? undefined : value[m[1]];
    var idx = m[2].match(/[0-9]+/g) || [];
    for (var j = 0; j < idx.length; j++) value = value === null || value === undefined ? undefined : value[Number(idx[j])];
  }
  return value;
}
var type = design.objectTypes[0];
var lines = [];
var problems = 0;
if (SOURCE === "prometheus") {
  for (var q = 0; q < type.metrics.length; q++) {
    var metric = type.metrics[q];
    var r = core.http("GET", baseUrl + "/api/v1/query?query=" + encodeURIComponent(metric.promql), headers, null, SAFE);
    var result = r.body && r.body.data ? r.body.data.result : null;
    if (!result || typeof result.length !== "number") {
      lines.push(metric.name + ": no data.result in the response");
      problems++;
      continue;
    }
    lines.push(metric.name + ": " + result.length + " series");
    for (var k = 0; k < result.length && k < 5; k++) {
      var label = result[k].metric ? result[k].metric[IDENTIFIER] : null;
      lines.push("  " + (label ? label : "(no " + IDENTIFIER + " label)") + "  " + (result[k].value ? result[k].value[1] : "?"));
    }
    if (result.length === 0) problems++;
  }
} else {
  var listed = core.http("GET", baseUrl + type.request.path, headers, null, SAFE);
  var items = pick(listed.body, type.request.itemsAt);
  var count = items && typeof items.length === "number" ? items.length : 0;
  lines.push(type.name + ": " + count + " item(s) at " + type.request.itemsAt);
  if (count === 0) problems++;
  for (var f = 0; f < type.metrics.length; f++) {
    var got = count > 0 ? pick(items[0], type.metrics[f].field) : undefined;
    if (got === undefined || got === null) problems++;
    lines.push(type.metrics[f].name + ": " + (got === undefined || got === null ? "MISSING" : JSON.stringify(got)));
  }
}
for (var l = 0; l < lines.length; l++) System.log(lines[l]);
report = lines.join("\n");
problemCount = problems;
summary = core.audit(null, { source: SOURCE, baseUrl: baseUrl, problems: problems });
core.notify(settings.webhook, summary);
if (problems > 0 && String(settings.failOnProblems) !== "false") throw new Error(problems + " quer(ies) or field(s) returned nothing to map; fix them before building the pack.");`;
      const pkg = toPackage({
        packageName,
        description: `Calls the ${source === 'prometheus' ? 'Prometheus server' : 'REST API'} the ${objectType} pack will read, the way Management Pack Builder will, and reports what comes back. Reads only. Generated by ArchToolKit.`,
        categoryPath: `ArchToolKit/VCF Operations/${base}`,
        workflow: {
          name: `Test pack source ${base}`,
          description: `Sends every ${source === 'prometheus' ? 'PromQL query (GET /api/v1/query)' : 'list request'} of the ${objectType} design once and reports the ${source === 'prometheus' ? 'series and their identifying label' : 'items and the fields each metric maps'}. Only GETs. Fails when a query returns nothing to map.`,
          inputs: [],
          outputs: [
            { name: 'report', type: 'string', description: 'What came back, one line per query or field' },
            { name: 'problemCount', type: 'number', description: 'Queries or fields with nothing to map' },
            { name: 'summary', type: 'string', description: 'The audit record, JSON' },
          ],
          script: mpbWorkflow,
        },
        config: {
          name: 'Settings',
          description: `Settings of the Test pack source ${base} workflow.${auth === 'none' ? '' : ' Fill sourceSecret after import.'}`,
          attributes: [
            { name: 'sourceUrl', type: 'string', value: baseUrl, description: 'The source base URL' },
            ...(auth === 'basic' ? [{ name: 'sourceUser', type: 'string'         , value: '', description: 'The account the pack will use' }] : []),
            ...(auth === 'none' ? [] : [{ name: 'sourceSecret', type: 'SecureString'         , description: auth === 'bearer' ? 'The bearer token the pack will use' : 'Its password' }]),
            { name: 'failOnProblems', type: 'boolean', value: true, description: 'Fail the run when a query or field returns nothing' },
            { name: 'webhook', type: 'SecureString', description: 'Optional: where the summary is posted' },
          ],
        },
        resources: [{ name: 'design.json', content: `${JSON.stringify(design, null, 2)}\n` }],
      });

      return {
        platform: PLATFORM,
        title: `Management Pack Builder design — ${objectType} from ${source === 'prometheus' ? 'Prometheus' : 'REST'}`,
        effect: 'read',
        trigger: { kind: 'schedule', detail: `Once built, the pack collects every ${interval} minutes; this design and test script only read.`, worstCase: `one request per query every ${interval} minutes, against the source` },
        scope: {
          what: `The source at ${baseUrl}, read-only; and, once built, objects of type ${objectType}.`,
          decidedBy: [source === 'prometheus' ? `Distinct values of the "${identifier}" label in the query results.` : `Items at ${itemsPath} in GET ${listPath}.`, 'Relationships, which place the new objects under existing ones.'],
          ifWrong: 'Objects that multiply every collection (an identifier that is not stable), or metrics attached to the wrong object. Both are cleaned up by deleting the objects, but their history is lost.',
        },
        guardrails: [
          { rule: 'The workflow and the test script only send GETs', because: 'Testing a source must not change it; a builder test against a write endpoint has changed production before.' },
          { rule: 'The credential is read from a mode-600 file and sent on stdin; in Orchestrator it is a SecureString, never logged', because: 'A source token on a command line is in the shell history of whoever tested the pack.' },
        ],
        dryRun: [`Run the workflow Test pack source ${base}, or scripts/test-source.sh: every query or request the pack will make, once, with the results printed.`],
        undo: ['Nothing to undo for the design. Once built and installed, uninstall the pack under Integrations > Repository.'],
        told: ['Nobody; it is a design. The test workflow posts its summary to the webhook in its settings, if one is set.'],
        requires: ['Network reach from the VCF Operations collector to the source, not only from your desktop (and from Orchestrator, for the test workflow).', 'jq and curl for the test script.', 'VCF Operations 9.1 or later for a Prometheus source.'],
        files: {
          ...pkg.files,
          [`${base}-design.json`]: `${JSON.stringify(design, null, 2)}\n`,
          [`${base}-design.md`]: md,
          'scripts/test-source.sh': test,
          'IMPORT.md': importMd({
            title: 'a Management Pack Builder design',
            intro: ['Management Pack Builder has no documented design-import format, so the design is a worksheet, not a file to import. What is imported is the Orchestrator package that tests the source; the design .md is built by hand in the builder.'],
            steps: [
              ...packageSteps(pkg, 'tests the source'),
              {
                heading: 'Then build the pack',
                files: [`${base}-design.md`, `${base}-design.json`],
                how: [
                  'Run the workflow (or ./scripts/test-source.sh) first: it calls the source the way the pack will, so a wrong URL or query shows here rather than in the builder.',
                  'Build the project in Administration → Management Pack Builder from the design .md, source by source and object by object.',
                  'When the project builds, export the .pak from the builder and install it like any other management pack (Administration → Integrations → Repository → Add, or "Install or upgrade a management pack" in this kit).',
                ],
              },
            ],
          }),
        },
        notes: [
          'CONFIRMED in the VCF Operations 9.1 release notes: "Prometheus support is now added to the Management Pack Builder in VCF Operations." The builder’s own design export format is not documented, so this design is a worksheet to build from, not a file to import.',
          'Use a stable identifier. A Prometheus instance label that includes a pod IP makes a new object every time the pod restarts.',
          'The Prometheus test uses GET /api/v1/query, the standard Prometheus HTTP API; the workflow reads data.result[].metric.<identifier> and value[1].',
        ],
        findings,
      };
    },
  }),

  // -------------------------------------------------------------------------
  automationBlueprint({
    id: 'vcfops_orchestrator',
    platform: PLATFORM,
    label: 'An orchestrator workflow in Python or PowerShell',
    group: 'Extend',
    description:
      'A scriptable workflow for the VCF Operations orchestrator in 9.1: the repository layout (with the dev and prod package repositories 9.1 lets a scripting environment use), a Python or PowerShell handler that defaults to a dry run, the error-handling pattern for the enhanced default error handler, and a script that starts the workflow over the orchestrator REST API.',
    inputs: [
      { id: 'workflow_name', label: 'Workflow name', control: 'text', default: 'Tag untagged VMs' },
      {
        id: 'language',
        label: 'Language',
        control: 'select',
        options: [
          { value: 'python', label: 'Python' },
          { value: 'powershell', label: 'PowerShell' },
        ],
        default: 'python',
      },
      { id: 'dev_repo', label: 'Development package repository', control: 'text', default: 'https://artifactory.example.com/api/pypi/pypi-dev/simple' },
      { id: 'prod_repo', label: 'Production package repository', control: 'text', default: 'https://artifactory.example.com/api/pypi/pypi-prod/simple' },
      { id: 'git_repo', label: 'Source repository', control: 'text', default: 'https://git.example.com/platform/vcf-orchestrator.git' },
      { id: 'session_timeout', label: 'UI session timeout (minutes)', control: 'number', default: 30, min: 5, max: 1440 },
      { id: 'reentry_limit', label: 'Error-handler re-entry limit', control: 'number', default: 1, min: 0, max: 10 },
    ],
    automation: (values                 , name        )             => {
      const wfName = str(values, 'workflow_name', 'Workflow');
      const language = str(values, 'language', 'python');
      const devRepo = str(values, 'dev_repo', '');
      const prodRepo = str(values, 'prod_repo', '');
      const gitRepo = str(values, 'git_repo', '');
      const timeout = num(values, 'session_timeout', 30);
      const reentry = num(values, 'reentry_limit', 1);
      const slug = slugOf(name || wfName, 'workflow');
      const py = language === 'python';

      const findings            = [];
      if (devRepo && devRepo === prodRepo) findings.push(warning('vcfops.orch.same-repo', 'Development and production use the same package repository.', { remediation: 'The point of two repositories in 9.1 is that a dependency is promoted, not picked up. Use two.', source: SRC }));
      if (timeout > 480) findings.push(warning('vcfops.orch.timeout', `A ${timeout}-minute session timeout keeps an unattended administrator session open all day.`, { source: SRC }));
      if (reentry > 3) findings.push(warning('vcfops.orch.reentry', `A re-entry limit of ${reentry} lets a failing error handler loop.`, { remediation: 'One is enough to report the error that happened inside the handler.', source: SRC }));

      const handler = py
        ? [
            '"""',
            `${wfName} — scriptable task for the VCF Operations orchestrator.`,
            '',
            'Generated by ArchToolKit. Defaults to a dry run: nothing changes unless the',
            'workflow input dryRun is false. Credentials come from the orchestrator',
            '(configuration elements or secure-string inputs), never from this file.',
            '"""',
            '',
            '',
            'def handler(context, inputs):',
            '    dry_run = inputs.get("dryRun", True)',
            '    targets = inputs.get("targets", [])',
            '    limit = int(inputs.get("maxTargets", 25))',
            '    if len(targets) > limit:',
            '        # Raising here sends the run to the workflow\'s error handler.',
            '        raise ValueError(f"{len(targets)} targets exceeds maxTargets={limit}; refusing to run")',
            '    changed = []',
            '    for target in targets:',
            '        if dry_run:',
            '            print(f"DRY RUN: would act on {target}")',
            '            continue',
            '        # TODO: the real change, one target at a time.',
            '        changed.append(target)',
            '    return {"dryRun": dry_run, "changed": changed, "count": len(changed)}',
            '',
          ].join('\n')
        : [
            '<#',
            `    ${wfName} — scriptable task for the VCF Operations orchestrator.`,
            '    Generated by ArchToolKit. Defaults to a dry run: nothing changes unless',
            '    the workflow input dryRun is false. Credentials come from the',
            '    orchestrator (configuration elements or secure-string inputs).',
            '#>',
            'function Handler($context, $inputs) {',
            '    $dryRun = if ($null -eq $inputs.dryRun) { $true } else { [bool]$inputs.dryRun }',
            '    $targets = @($inputs.targets)',
            '    $limit = if ($inputs.maxTargets) { [int]$inputs.maxTargets } else { 25 }',
            '    if ($targets.Count -gt $limit) {',
            '        # Throwing sends the run to the workflow\'s error handler.',
            '        throw "$($targets.Count) targets exceeds maxTargets=$limit; refusing to run"',
            '    }',
            '    $changed = @()',
            '    foreach ($target in $targets) {',
            '        if ($dryRun) { Write-Host "DRY RUN: would act on $target"; continue }',
            '        # TODO: the real change, one target at a time.',
            '        $changed += $target',
            '    }',
            '    return @{ dryRun = $dryRun; changed = $changed; count = $changed.Count }',
            '}',
            '',
          ].join('\n');

      const workflowSpec = {
        name: wfName,
        generatedBy: 'ArchToolKit',
        inputs: [
          { name: 'dryRun', type: 'boolean', default: true },
          { name: 'targets', type: 'Array/string' },
          { name: 'maxTargets', type: 'number', default: 25 },
        ],
        outputs: [{ name: 'result', type: 'Properties' }],
        items: [
          { type: 'scriptable-task', name: 'Act', runtime: py ? '<VERIFY — the Python runtime your 9.1 build offers, e.g. python:3.11>' : '<VERIFY — the PowerShell runtime your 9.1 build offers, e.g. powercli:13-powershell-7.4>', entryPoint: py ? 'handler.handler' : 'handler.ps1:Handler', environment: `${slug}-env` },
          { type: 'default-error-handler', name: 'On error', reentryLimit: reentry, action: 'Log the error and the item it came from, set result.failed = true, end the workflow in error.' },
        ],
        environment: {
          name: `${slug}-env`,
          language: py ? 'python' : 'powershell',
          repositories: [
            { name: 'dev', url: devRepo },
            { name: 'prod', url: prodRepo },
          ],
          dependencies: py ? ['requests'] : ['VMware.PowerCLI'],
        },
        uiSessionTimeoutMinutes: timeout,
      };

      const run = [
        '#!/usr/bin/env bash',
        `# Start "${wfName}" over the orchestrator REST API and wait for it.`,
        '#',
        '# Always sends dryRun=true unless --execute is given. The token comes from',
        '# ORCH_TOKEN, or from ORCH_TOKEN_FILE (mode 600).',
        'set -euo pipefail',
        ': "${ORCH_HOST:?set ORCH_HOST, e.g. vcfops-orch.example.com}"',
        ': "${WORKFLOW_ID:?set WORKFLOW_ID: GET /vco/api/workflows?conditions=name=... after importing}"',
        'if [[ -z "${ORCH_TOKEN:-}" && -n "${ORCH_TOKEN_FILE:-}" ]]; then ORCH_TOKEN=$(tr -d "\\n" < "$ORCH_TOKEN_FILE"); fi',
        ': "${ORCH_TOKEN:?set ORCH_TOKEN or ORCH_TOKEN_FILE — how it is obtained depends on the orchestrator authentication mode; VERIFY for 9.1}"',
        ...privateHeader('ORCH_AUTH', 'Authorization: Bearer', 'ORCH_TOKEN'),
        'command -v jq >/dev/null || { echo "jq is required" >&2; exit 2; }',
        'DRY=true; [[ "${1:-}" == "--execute" ]] && DRY=false',
        'TARGETS=${TARGETS:-}',
        '',
        '# The execution body is the standard orchestrator parameter list.',
        'BODY=$(jq -n --argjson dry "$DRY" --arg t "$TARGETS" \'{parameters: [',
        '  {name: "dryRun", type: "boolean", value: {boolean: {value: $dry}}},',
        '  {name: "targets", type: "Array/string", value: {array: {elements: [$t | split(",")[] | select(length > 0) | {string: {value: .}}]}}}',
        ']}\')',
        'echo "dryRun=${DRY}"',
        'orch() { curl -sS -f -H "@${ORCH_AUTH}" -H "Accept: application/json" -H "Content-Type: application/json" "$@"; }',
        'LOCATION=$(echo "$BODY" | orch -X POST "https://${ORCH_HOST}/vco/api/workflows/${WORKFLOW_ID}/executions" --data @- -D - -o /dev/null | tr -d "\\r" | awk -F": " \'tolower($1)=="location"{print $2}\')',
        '[[ -n "$LOCATION" ]] || { echo "The orchestrator started no execution (no Location header)." >&2; exit 1; }',
        'echo "execution ${LOCATION}"',
        'for _ in $(seq 1 60); do',
        '  STATE=$(orch "${LOCATION%/}/state" | jq -r .value)',
        '  echo "$(date +%T) ${STATE}"',
        '  case "$STATE" in completed) exit 0 ;; failed|canceled) exit 1 ;; esac',
        '  sleep 5',
        'done',
        'exit 1',
        '',
      ].join('\n');

      const layout = [
        `${slug}/`,
        '  README-workflow.txt      what the workflow does, its inputs, and who owns it',
        '  workflow.json            the workflow design (inputs, items, error handler, environment)',
        `  actions/${slug}/${py ? 'handler.py' : 'handler.ps1'}`,
        `  environment/${py ? 'requirements.txt' : 'modules.psd1'}  pinned dependencies, resolved from the dev or prod repository`,
        '  run-workflow.sh          start it over REST, dry run unless --execute',
        '',
        `Source: ${gitRepo || '(set a repository)'}. Branches: main is what runs in production; changes arrive by merge request.`,
        '',
        'Setup in the orchestrator 9.1 client:',
        `  1. Assets > Environments: create ${slug}-env (${py ? 'Python' : 'PowerShell'}), and add the two repositories —`,
        `     dev: ${devRepo || '(unset)'}`,
        `     prod: ${prodRepo || '(unset)'}`,
        '     9.1 allows up to two repositories per scripting environment. Point production at the prod one only.',
        '  2. Create the workflow with the scriptable task above, bound to that environment.',
        `  3. Add a Default error handler item. In 9.1 it can catch errors raised inside itself; set its re-entry limit to ${reentry}.`,
        `  4. Administration: set the UI session timeout to ${timeout} minutes (new in 9.1). VERIFY the exact setting location in your build.`,
        '',
      ].join('\n');

      // The same handler as one Orchestrator package in JavaScript, which the
      // package format carries and every Orchestrator runs: the dry run, the
      // maxTargets refusal and the one-target-at-a-time loop, with the change
      // itself in the action actOn — a template that refuses until it is written.
      const packageName = packageNameOf('vcfops', 'orch', slug);
      const jsName = wfName.replace(/\//g, '-').trim() || 'Workflow';
      const pkg = toPackage({
        packageName,
        description: `"${wfName}": the handler template as an ES5 workflow with the ArchToolKit guardrails. Generated by ArchToolKit.`,
        categoryPath: `ArchToolKit/VCF Operations/${slug}`,
        workflow: {
          name: jsName,
          description: `Acts on each target in turn through the action actOn, which is a template until its change is written. Refuses more than maxTargets (and the cap in the configuration element) before the first change. A dry run until dryRun is set to false in the configuration element.`,
          inputs: [
            { name: 'dryRun', type: 'boolean', description: 'true: report what would be acted on, change nothing' },
            { name: 'targets', type: 'Array/string', description: 'What to act on' },
            { name: 'maxTargets', type: 'number', description: 'Refuse more than this many targets; the cap in the settings is the ceiling' },
          ],
          outputs: [
            { name: 'result', type: 'string', description: 'JSON: dryRun, changed, count' },
            { name: 'summary', type: 'string', description: 'The audit record, JSON' },
          ],
          script: String.raw`var ctx = core.begin(settings, dryRun);
var list = targets || [];
var limit = ctx.cap;
if (maxTargets !== null && maxTargets !== undefined && String(maxTargets) !== "" && Number(maxTargets) < limit) limit = Number(maxTargets);
// Raising here, before the first change, is what stops a caller that passed a whole group by mistake.
if (list.length > limit) throw new Error(list.length + " targets exceeds maxTargets=" + limit + "; refusing to run");
var changed = [];
for (var i = 0; i < list.length; i++) {
  var target = String(list[i]);
  core.act(ctx, "act on " + target, function () { return mod.actOn(target, settings); });
  if (!ctx.dryRun) changed.push(target);
}
result = JSON.stringify({ dryRun: ctx.dryRun, changed: changed, count: changed.length });
summary = core.audit(ctx, { targets: list.length, changed: changed });
core.notify(settings.webhook, summary);`,
        },
        actions: [
          {
            name: 'actOn',
            description: 'The change for one target: the template\'s TODO. Until it is written an armed run stops at the first target, having changed nothing. Write the change here, and its reverse in the README, before arming.',
            resultType: 'Any',
            params: [ap('target', 'string', 'One target'), ap('settings', 'Any', 'The configuration element, as core.settings returned it')],
            script: String.raw`// TODO: the real change, for this one target. Credentials come from settings (SecureString attributes), never from this script.
throw new Error("actOn is a template: write the change for one target in the action ${packageName}/actOn before arming this workflow. Nothing was changed for " + target + ".");`,
          },
        ],
        config: {
          name: 'Settings',
          description: `Settings of the "${jsName}" workflow. Set dryRun to false only after the change in actOn is written and a dry run has been read.`,
          attributes: [
            { name: 'dryRun', type: 'boolean', value: true, description: 'The arming switch: nothing is changed while this is true' },
            { name: 'cap', type: 'number', value: 25, description: 'The most targets one run may act on' },
            { name: 'webhook', type: 'SecureString', description: 'Optional: where the audit record is posted' },
          ],
        },
      });

      return {
        platform: PLATFORM,
        title: `Orchestrator workflow "${wfName}" (${py ? 'Python' : 'PowerShell'})`,
        effect: 'reversible',
        trigger: { kind: 'manual', detail: 'Started by scripts/run-workflow.sh, a person in the client, or a VCF Operations action that calls it.', worstCase: 'once per call; an alert-driven caller can call it once per alert' },
        scope: {
          what: 'The targets passed in the targets input, at most maxTargets of them per run.',
          decidedBy: ['Whoever calls it decides the targets list.', 'maxTargets (default 25) caps it.', 'The orchestrator account’s own permissions on the systems the handler touches.'],
          ifWrong: 'The handler acts on every target it is given, up to the cap. The cap is what keeps a wrong list at 25 objects instead of the estate.',
        },
        guardrails: [
          { rule: 'dryRun defaults to true in the workflow and in the handler', because: 'A workflow started from the client with default inputs must not change anything.' },
          { rule: 'The handler refuses more than maxTargets targets', because: 'A caller passing a whole custom group by mistake is stopped before the first change.' },
          { rule: 'run-workflow.sh sends dryRun=false only with --execute', because: 'A test run from a terminal should not be the one that acts.' },
          { rule: `The JavaScript package workflow "${jsName}" is a dry run until dryRun is false in its configuration element, refuses more targets than maxTargets or its cap (25), and its action actOn refuses until the change is written`, because: 'A template that runs armed with an empty change reports success for work it never did.' },
          { rule: 'run-workflow.sh gives the token to curl from a private header file (mode 600, removed on exit), never as an argument', because: 'A token on a command line is readable by every user of the jump host through ps.' },
          { rule: `The default error handler has a re-entry limit of ${reentry}`, because: '9.1 lets the handler catch its own errors; without a limit a failing handler loops.' },
        ],
        dryRun: ['Run scripts/run-workflow.sh without --execute: the workflow runs with dryRun=true and prints what it would act on.', `Or run the package workflow "${jsName}" with dryRun = true: every target is a "DRY RUN: would act on …" line.`],
        undo: ['The workflow itself is deleted in the client. What the handler changed is reversed by whatever the TODO does — write the reverse into the handler before taking the TODO out.'],
        told: ['The workflow run log in the orchestrator, with every DRY RUN line.', 'The caller, through the result output.'],
        requires: [
          'VCF Operations orchestrator 9.1 for the two-repository environments, the self-catching error handler and the session timeout setting.',
          'The two package repositories reachable from the orchestrator appliance.',
          'jq and curl for run-workflow.sh.',
        ],
        files: {
          ...pkg.files,
          'layout.txt': layout,
          'workflow.json': `${JSON.stringify(workflowSpec, null, 2)}\n`,
          [`actions/${slug}/${py ? 'handler.py' : 'handler.ps1'}`]: handler,
          [`import/${slug}-action.zip/${py ? 'handler.py' : 'handler.ps1'}`]: handler,
          [py ? 'environment/requirements.txt' : 'environment/modules.psd1']: py ? 'requests==2.32.3\n' : "@{ RequiredModules = @(@{ ModuleName = 'VMware.PowerCLI'; RequiredVersion = '<VERIFY — the PowerCLI version your runtime supports>' }) }\n",
          'scripts/run-workflow.sh': run,
          'IMPORT.md': importMd({
            title: `the orchestrator workflow "${wfName}"`,
            steps: [
              ...packageSteps(pkg, `runs "${jsName}" in JavaScript, with the guardrails`),
              {
                heading: `Before arming the package workflow: write actOn`,
                files: [],
                how: [`The action ${packageName}/actOn is the handler's TODO: an armed run stops at the first target with "actOn is a template" and changes nothing until it is written. Write the change for one target there, and its reverse in the README, then run a dry run and set dryRun to false.`],
              },
              {
                heading: 'The scripting environment',
                files: [py ? 'environment/requirements.txt' : 'environment/modules.psd1'],
                how: [`Orchestrator → Assets → Environments → New: runtime ${py ? 'Python' : 'PowerShell'}, the dependencies from this file, and the package repositories in layout.txt.`],
              },
              {
                heading: 'The action',
                files: [`import/${slug}-action.zip`],
                how: [`Orchestrator → Library → Actions → New: runtime ${py ? 'Python' : 'PowerShell'} with the environment above, script type "Import package", and choose import/${slug}-action.zip — the handler at the root of the zip, entry handler ${py ? 'handler.handler' : 'handler.Handler'}.`],
                verify: ['the orchestrator in VCF Operations 9.1 is documented only in the release notes; the zip-package route is the long-standing Orchestrator one for Python and PowerShell actions.'],
              },
              {
                heading: 'The workflow',
                files: ['workflow.json'],
                how: ['workflow.json is a design record of the Python/PowerShell workflow, not the orchestrator\'s package format. Create that workflow in the workflow editor with one scriptable task that calls the action, with the inputs listed there — or use the JavaScript package above, which is the same workflow as an importable package.', 'Then ./scripts/run-workflow.sh starts either over the REST API (POST /vco/api/workflows/{id}/executions).'],
              },
            ],
          }),
        },
        notes: [
          'CONFIRMED in the 9.1 release notes: up to two repositories for Python and PowerShell scripting environments, a default error handler that can catch errors raised inside itself with a configurable re-entry limit, and a configurable UI session timeout.',
          'VERIFY: whether "repositories" in your build means package sources (as written here) or Git sources; the runtime names; and how ORCH_TOKEN is issued in your authentication mode. workflow.json is a design record, not the orchestrator’s package format — create the workflow in the client or import it as a package you exported.',
          'POST /vco/api/workflows/{id}/executions with a parameters list, the Location header and GET …/executions/{id}/state are the long-standing orchestrator REST calls.',
        ],
        findings,
      };
    },
  }),

  // -------------------------------------------------------------------------
  automationBlueprint({
    id: 'vcfops_integrations_hcx',
    platform: PLATFORM,
    label: 'HCX migration readiness report',
    group: 'Extend',
    description:
      'A read-only readiness report before a migration wave: is the 9.1 HCX management pack installed in VCF Operations, is HCX Manager answering, what version it is, how long its certificate has left, and whether the service meshes are up. It exits non-zero on anything that should stop a wave.',
    inputs: [
      { id: 'hcx_host', label: 'HCX Manager', control: 'text', default: 'hcx-mgr01.example.com' },
      { id: 'hcx_user', label: 'HCX user', control: 'text', default: 'svc-hcx-readonly@vsphere.local' },
      { id: 'cert_days', label: 'Warn when the certificate expires within (days)', control: 'number', default: 30, min: 1, max: 365 },
      { id: 'check_mp', label: 'Check the HCX management pack in VCF Operations', control: 'toggle', default: true },
    ],
    automation: (values                 , name        )             => {
      const hcx = str(values, 'hcx_host', 'hcx.example.com');
      const user = str(values, 'hcx_user', '');
      const days = num(values, 'cert_days', 30);
      const checkMp = bool(values, 'check_mp', true);
      const base = slugOf(name || 'hcx-readiness', 'hcx-readiness');

      const findings            = [];
      if (/^admin(istrator)?(@|$)/i.test(user)) {
        findings.push(warning('vcfops.hcx.admin', `${user} is an administrator account for a read-only report.`, { remediation: 'Use an account with a read-only role in HCX; a report does not need to be able to start a migration.', source: SRC }));
      }

      const script = readScript(PLATFORM, `HCX migration readiness for ${hcx}. Reads only; exits 1 when something should stop a wave.`, [
        `HCX='${sq(hcx)}'`,
        `: "\${HCX_USER:=${sq(user)}}"`,
        ': "${HCX_PASSWORD_FILE:?set HCX_PASSWORD_FILE to a file holding the HCX user password, mode 600}"',
        'PROBLEMS=0',
        'problem() { echo "PROBLEM: $*"; PROBLEMS=1; }',
        '',
        ...(checkMp
          ? [
              '# 1. The HCX management pack in VCF Operations (new in 9.1: password and',
              '#    certificate rotation, log bundles).',
              "MP=$(get /suite-api/api/solutions | jq -r '[.solution[]? | select(.name | test(\"HCX\"; \"i\")) | \"\\(.name) \\(.version)\"] | first // empty')",
              '[[ -n "$MP" ]] && echo "management pack: $MP" || problem "no HCX management pack is installed in VCF Operations"',
              '',
            ]
          : []),
        '# 2. The certificate HCX Manager presents.',
        'END=$(echo | openssl s_client -connect "${HCX}:443" -servername "$HCX" 2>/dev/null | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2) || true',
        'if [[ -z "$END" ]]; then',
        '  problem "could not read a certificate from ${HCX}:443"',
        'else',
        '  LEFT=$(( ( $(date -d "$END" +%s) - $(date +%s) ) / 86400 ))',
        '  echo "certificate: ${LEFT} days left (${END})"',
        `  (( LEFT >= ${days} )) || problem "certificate expires in \${LEFT} days"`,
        'fi',
        '',
        '# 3. Log in to HCX. The password is sent on stdin; the session token comes back',
        '#    in the x-hm-authorization header.',
        'SESSION=$(jq -n --arg u "$HCX_USER" --rawfile p "$HCX_PASSWORD_FILE" \'{username: $u, password: ($p | rtrimstr("\\n"))}\' |',
        '  curl -sS -f -X POST "https://${HCX}/hybridity/api/sessions" -H "Accept: application/json" -H "Content-Type: application/json" --data @- -D - -o /dev/null |',
        '  tr -d "\\r" | awk -F": " \'tolower($1)=="x-hm-authorization"{print $2}\') || true',
        'if [[ -z "$SESSION" ]]; then',
        '  problem "HCX Manager did not accept the login"',
        '  exit 1',
        'fi',
        '# The session token goes to curl from a private header file, never as an argument.',
        ...privateHeader('HCX_AUTH', 'x-hm-authorization:', 'SESSION'),
        'hcx() { curl -sS -f "https://${HCX}$1" -H "@${HCX_AUTH}" -H "Accept: application/json"; }',
        '',
        '# 4. Version, and the service meshes. VERIFY both paths on your HCX release.',
        "VERSION=$(hcx /hybridity/api/appliance/version 2>/dev/null | jq -r '.version // .buildVersion // empty') || true",
        'echo "HCX version: ${VERSION:-unknown (VERIFY the version path)}"',
        'MESHES=$(hcx /hybridity/api/interconnect/serviceMesh 2>/dev/null) || { problem "could not list service meshes (VERIFY the path)"; MESHES=\'{}\'; }',
        "jq -r '(.items // .data.items // [])[] | \"mesh \\(.name // .serviceMeshId): \\(.status // .state // \"?\")\"' <<<\"$MESHES\"",
        "BAD=$(jq '[(.items // .data.items // [])[] | select(((.status // .state // \"\") | ascii_upcase) | test(\"UP|OK|HEALTHY|DEPLOYED|SUCCESS\") | not)] | length' <<<\"$MESHES\")",
        '(( BAD == 0 )) || problem "${BAD} service mesh(es) not reporting up"',
        '',
        '# Logging out is best effort: a failure here does not change the result.',
        'curl -sS -X DELETE "https://${HCX}/hybridity/api/sessions" -H "@${HCX_AUTH}" >/dev/null 2>&1 || true',
        '(( PROBLEMS )) && echo "Not ready: fix the problems above before starting a wave." || echo "Ready."',
        'exit $PROBLEMS',
      ]);

      const checklist = [
        'HCX in VCF 9.1 — lifecycle and management pack checklist (manual items)',
        '',
        '[ ] HCX Manager is deployed and upgraded through VCF Operations in 9.1; confirm the',
        '    target version appears in fleet lifecycle before planning an upgrade mid-migration.',
        '[ ] The HCX management pack is installed in VCF Operations (see "Install or upgrade',
        '    a management pack"), and its account is collecting.',
        '[ ] Local-user password rotation and certificate rotation are done from the',
        '    management pack, not by hand, so VCF Operations stays the record.',
        '[ ] New service meshes in 9.1 use the enhanced Interconnect / Network Extension',
        '    architecture automatically; check existing meshes before mixing the two.',
        '[ ] No HCX upgrade is scheduled inside a migration wave window.',
        '[ ] A log bundle can be collected from the management pack (test it once).',
        '',
      ].join('\n');

      const packageName = packageNameOf('vcfops', 'hcx', base);
      const hcxWorkflow = String.raw`var CHECK_MP = ${checkMp ? 'true' : 'false'};
var problems = [];
var lines = [];
function problem(text) { problems.push(text); lines.push("PROBLEM: " + text); System.warn("PROBLEM: " + text); }
function note(text) { lines.push(text); System.log(text); }
var SAFE = { redact: settings._secrets };
if (!settings.hcxHost) throw new Error("Set hcxHost in the configuration element " + SETTINGS_NAME + ".");
if (!settings.hcxUsername || !settings.hcxPassword) throw new Error("Set hcxUsername and hcxPassword in the configuration element " + SETTINGS_NAME + ".");

// 1. The HCX management pack in VCF Operations (new in 9.1: password and certificate rotation, log bundles).
if (CHECK_MP) {
  ${OPS_LOGIN.split('\n').join('\n  ')}
  try {
    var listed = core.http("GET", "https://" + settings.opsHost + "/suite-api/api/solutions", auth, null, SAFE).body || {};
    var mp = null;
    var solutions = listed.solution || [];
    for (var i = 0; i < solutions.length && !mp; i++) {
      if (/HCX/i.test(String(solutions[i].name)) || /HCX/i.test((solutions[i].adapterKindKeys || []).join(" "))) mp = solutions[i];
    }
    if (mp) note("management pack: " + mp.name + " " + mp.version);
    else problem("no HCX management pack is installed in VCF Operations");
  } finally {
    core.logoutVcfOps(settings.opsHost, auth);
  }
}

// 2. HCX Manager: log in (the session token comes back in the x-hm-authorization header), read, log out.
var hcx = "https://" + settings.hcxHost;
var session = mod.hcxLogin(settings.hcxHost, settings.hcxUsername, settings.hcxPassword);
if (!session) {
  problem("HCX Manager did not accept the login, or returned no x-hm-authorization header");
} else {
  var READ = { redact: settings._secrets, allow: [404] };
  try {
    var ver = core.http("GET", hcx + "/hybridity/api/appliance/version", session, null, READ);
    var version = ver.statusCode === 200 && ver.body ? ver.body.version || ver.body.buildVersion || "" : "";
    note("HCX version: " + (version || "unknown (VERIFY the version path)"));
    var meshes = core.http("GET", hcx + "/hybridity/api/interconnect/serviceMesh", session, null, READ);
    if (meshes.statusCode !== 200) {
      problem("could not list service meshes (HTTP " + meshes.statusCode + "; VERIFY the path)");
    } else {
      var items = meshes.body.items || (meshes.body.data && meshes.body.data.items) || [];
      var bad = 0;
      for (var m = 0; m < items.length; m++) {
        var state = String(items[m].status || items[m].state || "?");
        note("mesh " + (items[m].name || items[m].serviceMeshId) + ": " + state);
        if (!/UP|OK|HEALTHY|DEPLOYED|SUCCESS/i.test(state)) bad++;
      }
      if (bad > 0) problem(bad + " service mesh(es) not reporting up");
    }
  } finally {
    // Logging out is best effort: a failure here does not change the result.
    try { core.http("DELETE", hcx + "/hybridity/api/sessions", session, null, READ); } catch (e) { System.warn("Could not end the HCX session: " + e); }
  }
}
note("certificate: not read by the workflow (Orchestrator has no call for a peer certificate); scripts/${base}.sh checks it with openssl, and VCF Operations 9.1 tracks certificates under Fleet Management.");
report = lines.join("\n");
problemCount = problems.length;
summary = core.audit(null, { hcxHost: settings.hcxHost, problems: problems, ready: problems.length === 0 });
core.notify(settings.webhook, summary);
if (problems.length > 0 && String(settings.failOnProblems) !== "false") throw new Error("Not ready: " + problems.join("; "));`;
      const pkg = toPackage({
        packageName,
        description: `HCX migration readiness for ${hcx}: the management pack in VCF Operations, the login, the version and the service meshes. Reads only. Generated by ArchToolKit.`,
        categoryPath: `ArchToolKit/VCF Operations/${base}`,
        workflow: {
          name: `HCX readiness ${base}`,
          description: 'Reads the solutions list in VCF Operations and HCX Manager (login, version, service meshes, logout) and reports what should stop a migration wave. Changes nothing; fails when there is a problem, so a schedule or a pipeline gate shows it.',
          inputs: [],
          outputs: [
            { name: 'report', type: 'string', description: 'One line per check' },
            { name: 'problemCount', type: 'number', description: 'Problems that should stop a wave' },
            { name: 'summary', type: 'string', description: 'The audit record, JSON' },
          ],
          script: hcxWorkflow,
        },
        actions: [
          {
            name: 'hcxLogin',
            description: 'HCX Manager: POST /hybridity/api/sessions {username, password}. Returns { "x-hm-authorization": <token> } from the response header, or null when the login fails or the header is missing. core.http does not return response headers, so this makes the call itself.',
            resultType: 'Any',
            params: [ap('host', 'string', 'HCX Manager host'), ap('username', 'string', 'Account'), ap('password', 'string', 'From a SecureString attribute')],
            script: String.raw`var h = RESTHostManager.createHost("archtoolkit-hcx");
h.url = "https://" + host;
h.connectionTimeout = 60;
h.operationTimeout = 60;
var request = RESTHostManager.createTransientHostFrom(h).createRequest("POST", "/hybridity/api/sessions", JSON.stringify({ username: String(username), password: String(password) }));
request.contentType = "application/json";
request.setHeader("Accept", "application/json");
var response;
try {
  response = request.execute();
} catch (e) {
  throw new Error("POST https://" + host + "/hybridity/api/sessions failed: " + String(e).split(String(password)).join("****"));
}
var status = Number(response.statusCode);
if (status < 200 || status > 299) {
  System.warn("The HCX login returned HTTP " + status + ".");
  return null;
}
var all = response.getAllHeaders ? response.getAllHeaders() : null;
var value = null;
if (all) {
  var keys = typeof all.keys === "function" ? all.keys() : null;
  if (keys) {
    for (var i = 0; i < keys.length; i++) if (String(keys[i]).toLowerCase() === "x-hm-authorization") value = all.get(keys[i]);
  } else {
    for (var k in all) if (all.hasOwnProperty(k) && String(k).toLowerCase() === "x-hm-authorization") value = all[k];
  }
}
return value ? { "x-hm-authorization": String(value) } : null;`,
          },
        ],
        config: {
          name: 'Settings',
          description: `Settings of the HCX readiness ${base} workflow. Fill the passwords after import.`,
          attributes: [
            { name: 'hcxHost', type: 'string', value: hcx, description: 'HCX Manager' },
            { name: 'hcxUsername', type: 'string', value: user, description: 'A read-only HCX account' },
            { name: 'hcxPassword', type: 'SecureString', description: 'Its password' },
            ...(checkMp ? OPS_ATTRIBUTES : []),
            { name: 'failOnProblems', type: 'boolean', value: true, description: 'Fail the run when something should stop a wave' },
            { name: 'webhook', type: 'SecureString', description: 'Optional: where the summary is posted' },
          ],
        },
      });

      return {
        platform: PLATFORM,
        title: `HCX readiness — ${hcx}`,
        effect: 'read',
        trigger: { kind: 'manual', detail: 'Before each migration wave, and the morning of it.', worstCase: 'as often as someone runs it' },
        scope: {
          what: `HCX Manager ${hcx} and the solutions list in VCF Operations. Reads only.`,
          decidedBy: ['The HCX account’s read permissions.', 'The VCF Operations account’s read permissions.'],
          ifWrong: 'A report that says ready when it is not. Nothing is changed either way.',
        },
        guardrails: [
          { rule: 'Only GETs, a login and a logout — in the workflow and the script', because: 'A readiness check that can change HCX is a migration risk of its own.' },
          { rule: 'Password from a mode-600 file, sent on stdin; the session token passed to curl from a private header file; in Orchestrator SecureStrings, never logged', because: 'Neither the HCX password nor the session token appears in a process list or a crontab.' },
        ],
        dryRun: ['It only reads; running it (the workflow or the script) is the dry run.'],
        undo: ['Nothing to undo.'],
        told: ['Whoever runs it; the failed run (the exit code of the script) for a pipeline gate; the webhook in the workflow settings, if set.'],
        requires: ['openssl, jq and curl for the script.', 'A read-only HCX account, and a VCF Operations account for the solutions check.', 'For the package: VCF Automation 9.1 (or VCF Operations orchestrator 9.1) with the HCX Manager and VCF Operations certificates trusted in Orchestrator.'],
        files: {
          ...pkg.files,
          [`scripts/${base}.sh`]: script,
          'hcx-91-checklist.txt': checklist,
          'IMPORT.md': importMd({
            title: 'the HCX readiness report',
            intro: ['An Orchestrator package that reads VCF Operations and HCX Manager and changes nothing, and the same check as a script. Run either before each migration wave; both fail on anything that should stop the wave.'],
            steps: [
              ...packageSteps(pkg, 'checks readiness'),
              {
                heading: 'What the workflow calls',
                files: [],
                how: [
                  `${checkMp ? 'VCF Operations: POST /suite-api/api/auth/token/acquire, GET /suite-api/api/solutions (an HCX management pack by name or adapter kind), POST …/auth/token/release. ' : ''}HCX Manager: POST /hybridity/api/sessions (the token is the x-hm-authorization response header), GET /hybridity/api/appliance/version, GET /hybridity/api/interconnect/serviceMesh, DELETE /hybridity/api/sessions.`,
                  `The certificate check is the script\'s: Orchestrator has no scripting call that reads a server\'s certificate. Run scripts/${base}.sh for it.`,
                ],
                verify: ['GET /hybridity/api/appliance/version and /hybridity/api/interconnect/serviceMesh and their field names on your HCX release: the workflow reports a problem rather than passing if they differ.'],
              },
              {
                heading: 'Or: the script, from a Linux host',
                files: [`scripts/${base}.sh`, 'hcx-91-checklist.txt'],
                how: [
                  `scripts/${base}.sh reads VCF Operations and HCX Manager and changes nothing, and also checks the certificate HCX Manager presents. Run it from a host that can reach both; it exits non-zero on anything that should stop the wave.`,
                  'hcx-91-checklist.txt is for a person. The HCX management pack it checks for is a .pak installed under Administration → Integrations → Repository.',
                ],
              },
            ],
          }),
        },
        notes: [
          'CONFIRMED in the 9.1 release notes: an HCX management pack for VCF Operations (password rotation for local users, certificate rotation, log bundle collection), and HCX Manager lifecycle through VCF Operations.',
          'POST /hybridity/api/sessions and the x-hm-authorization header are the long-standing HCX login. VERIFY: /hybridity/api/appliance/version and /hybridity/api/interconnect/serviceMesh and their field names on your HCX release — the script reports a problem rather than passing if they differ.',
        ],
        findings,
      };
    },
  }),
];

// ---------------------------------------------------------------------------
// VCF Operations for Networks 9.1
// ---------------------------------------------------------------------------

/** Login plus the /api/ni call helper. */
function niPreamble()           {
  return [
    ...networksPreamble(),
    '',
    '# The token goes to curl from a private header file, never as an argument.',
    ...privateHeader('NI_AUTH', 'Authorization: NetworkInsight', 'VCFNET_TOKEN'),
    'ni() {',
    '  local method="$1" path="$2"; shift 2',
    '  curl -sS -f -X "$method" "https://${VCFNET_HOST}/api/ni${path}" \\',
    '    -H "@${NI_AUTH}" \\',
    '    -H "Accept: application/json" -H "Content-Type: application/json" "$@"',
    '}',
    '# The search bar’s language, as POST /search/ql {query, size}.',
    "ql() { jq -n --arg q \"$1\" --argjson s \"${2:-100}\" '{query: $q, size: $s}' | ni POST /search/ql --data @-; }",
  ];
}

/**
 * The start of every Networks workflow: settings checked, the login, and
 * count(query) — the search bar's language through POST /api/ni/search/ql
 * {query, size}. The 9.x API reference answers with search_response_total_hits
 * and entity_list_response; the count is entity_list_response.total_count, or
 * the total hits when that is absent, and a response with neither is an error,
 * never a zero. The caller logs out in a finally.
 */
const NET_LOGIN = String.raw`if (!settings.netHost) throw new Error("Set netHost in the configuration element " + SETTINGS_NAME + ".");
if (!settings.netUsername || !settings.netPassword) throw new Error("Set netUsername and netPassword in the configuration element " + SETTINGS_NAME + ".");
var SAFE = { redact: settings._secrets };
var ni = "https://" + settings.netHost + "/api/ni";
var auth = core.loginVcfNetworks(settings.netHost, settings.netUsername, settings.netPassword, settings.netDomainType || "LOCAL", settings.netDomain || "local");
function count(query) {
  var b = core.http("POST", ni + "/search/ql", auth, { query: query, size: 1 }, SAFE).body || {};
  var list = b.entity_list_response;
  var n = list && list.total_count !== undefined && list.total_count !== null ? list.total_count : b.search_response_total_hits;
  if (n === undefined || n === null) throw new Error("No total in the search response for: " + query + " (VERIFY the response on your release).");
  return Number(n);
}`;

/** An Orchestrator package for a read-only Networks report. */
function networksPackage(opts   
                        
                         
                               
                                
                                       
                                                                                   
                          
                                                                                                                                                                                  
                                                                    
 )                    {
  return toPackage({
    packageName: packageNameOf('vcfnet', opts.thing, opts.base),
    description: `${opts.description} Reads only. Generated by ArchToolKit.`,
    categoryPath: `ArchToolKit/VCF Operations for Networks/${opts.base}`,
    workflow: { name: opts.workflowName, description: opts.workflowDescription, inputs: [], outputs: [...opts.outputs, { name: 'summary', type: 'string', description: 'The audit record, JSON' }], script: opts.script },
    config: {
      name: 'Settings',
      description: `Settings of the ${opts.workflowName} workflow. Fill netPassword after import.`,
      attributes: [...NET_ATTRIBUTES, ...(opts.extra ?? []), { name: 'webhook', type: 'SecureString', description: 'Optional: where the summary is posted' }],
    },
    resources: opts.resources,
  });
}

/** What every Networks package workflow runs on, for its README. */
const NET_PACKAGE_REQUIRES = 'For the package: VCF Automation 9.1 (or VCF Operations orchestrator 9.1) with the VCF Operations for Networks certificate trusted in Orchestrator.';

function niScript(purpose        , body                   )         {
  return ['#!/usr/bin/env bash', `# ${purpose}`, '#', '# Reads only.', 'set -euo pipefail', '', ...niPreamble(), '', ...body, ''].join('\n');
}

                      
                        
                      
                          
 

function parseDependencies(text        )                                        {
  const deps               = [];
  const bad           = [];
  for (const line of text.split('\n').map((l) => l.trim()).filter(Boolean)) {
    const m = /^(.+?)\s*->\s*(.+?)(?:\s*:\s*(\d+(?:\.\d+)?))?$/.exec(line);
    if (!m) {
      bad.push(line);
      continue;
    }
    deps.push({ from: m[1] .trim(), to: m[2] .trim(), weight: m[3] ? Number(m[3]) : 1 });
  }
  return { deps, bad };
}

function parseSizes(text        )                      {
  const sizes = new Map                ();
  for (const line of text.split('\n').map((l) => l.trim()).filter(Boolean)) {
    const at = line.lastIndexOf('=');
    if (at < 0) continue;
    const n = Number(line.slice(at + 1).trim());
    if (Number.isFinite(n) && n >= 0) sizes.set(line.slice(0, at).trim(), n);
  }
  return sizes;
}

                           
                                                                                                              
                                                                                                                 
                                            
                                        
 

/**
 * Flows to groups to waves.
 *
 * Applications that talk above the threshold move together (union-find over
 * the strong edges), because splitting them puts their traffic across the
 * interconnect for the length of the migration. Groups are then packed into
 * waves smallest first — the quick wins in wave 1, as on the Migration page —
 * up to the VM cap. Weaker dependencies that end up split across waves are
 * listed rather than hidden.
 */
export function planWaves(apps                   , deps                       , sizes                             , threshold        , cap        )           {
  const parent = new Map                (apps.map((app) => [app, app]));
  const find = (x        )         => {
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root) ;
    parent.set(x, root);
    return root;
  };
  for (const dep of deps) {
    if (dep.weight >= threshold) {
      const a = find(dep.from);
      const b = find(dep.to);
      if (a !== b) parent.set(a, b);
    }
  }
  const byRoot = new Map                  ();
  for (const app of apps) byRoot.set(find(app), [...(byRoot.get(find(app)) ?? []), app]);
  const vmsOf = (list                   ) => list.reduce((sum, app) => sum + (sizes.get(app) ?? 1), 0);
  const groups = [...byRoot.values()]
    .map((list) => [...list].sort())
    .sort((a, b) => vmsOf(a) - vmsOf(b) || a[0] .localeCompare(b[0] ))
    .map((list, index) => ({ id: index + 1, apps: list, vms: vmsOf(list) }));

  const waves                                                    = [];
  for (const group of groups) {
    const last = waves[waves.length - 1];
    if (last && last.vms + group.vms <= cap) {
      last.groups.push(group.id);
      last.vms += group.vms;
    } else {
      waves.push({ wave: waves.length + 1, groups: [group.id], vms: group.vms });
    }
  }
  const waveOfApp = new Map                ();
  for (const wave of waves) for (const id of wave.groups) for (const app of groups[id - 1] .apps) waveOfApp.set(app, wave.wave);
  const crossWave = deps.filter((dep) => waveOfApp.get(dep.from) !== waveOfApp.get(dep.to));
  return { groups, waves, crossWave, oversized: groups.filter((g) => g.vms > cap).map((g) => g.id) };
}

export const NETWORKS_91                                 = [
  // -------------------------------------------------------------------------
  automationBlueprint({
    id: 'vcfnet91_vpc_planning',
    platform: NETWORKS,
    label: 'Plan VPCs from port groups and flows (9.1)',
    group: 'VCF 9.1 planning',
    description:
      'The groundwork for moving from vSphere port groups to NSX VPCs: for one vCenter and distributed switch, which port groups there are, how many VMs sit on each and who talks to whom — exported to CSV — and a proposed VPC with one subnet per port group, as an NSX Policy API payload skeleton to review. It reads Networks and writes files; it does not touch NSX.',
    inputs: [
      { id: 'vcenter', label: 'vCenter', control: 'text', default: 'vcenter-wld01.example.com' },
      { id: 'vds', label: 'Distributed switch', control: 'text', default: 'wld01-vds01' },
      { id: 'project', label: 'NSX project', control: 'text', default: 'default' },
      { id: 'vpc_name', label: 'Proposed VPC', control: 'text', default: 'orders-vpc' },
      {
        id: 'subnets',
        label: 'Port groups to subnets',
        control: 'textarea',
        default: 'pg-orders-web = 10.20.1.0/24 Public\npg-orders-app = 10.20.2.0/24 Private\npg-orders-db = 10.20.3.0/24 Isolated',
        hint: 'One per line: port group = CIDR access-mode (Public, Private, Isolated)',
      },
      { id: 'days', label: 'Flows over the last (days)', control: 'number', default: 7, min: 1, max: 30 },
    ],
    automation: (values                 , name        )             => {
      const vcenter = str(values, 'vcenter', '');
      const vds = str(values, 'vds', '');
      const project = str(values, 'project', 'default');
      const vpc = str(values, 'vpc_name', 'vpc');
      const days = num(values, 'days', 7);
      const base = slugOf(name || vpc, 'vpc-plan');
      const vpcId = slugOf(vpc, 'vpc');

      const findings            = [];
      const rows = str(values, 'subnets', '')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const m = /^(.+?)\s*=\s*(\d+\.\d+\.\d+\.\d+\/\d+)\s*(\w+)?$/.exec(line);
          if (!m) {
            findings.push(error('vcfnet91.vpc.bad-line', `"${line}" is not "port group = CIDR mode".`, { source: SRC }));
            return undefined;
          }
          return { pg: m[1] .trim(), cidr: m[2] , mode: m[3] ?? 'Private' };
        })
        .filter((row)                                                    => row !== undefined);
      if (rows.length === 0) findings.push(error('vcfnet91.vpc.none', 'No port groups to plan.', { source: SRC }));
      const badMode = rows.filter((row) => !['Public', 'Private', 'Isolated'].includes(row.mode));
      if (badMode.length > 0) findings.push(warning('vcfnet91.vpc.mode', `Unknown access mode on ${badMode.map((r) => r.pg).join(', ')}.`, { remediation: 'Use Public, Private or Isolated; VERIFY the exact enum (for example Private_TGW) in your NSX release.', source: SRC }));
      const toInt = (cidr        ) => {
        const [ip = '0.0.0.0', bits = '32'] = cidr.split('/');
        const n = ip.split('.').reduce((acc, octet) => acc * 256 + Number(octet), 0);
        const size = 2 ** (32 - Number(bits));
        return { start: n - (n % size), end: n - (n % size) + size - 1 };
      };
      for (let i = 0; i < rows.length; i += 1) {
        for (let j = i + 1; j < rows.length; j += 1) {
          const a = toInt(rows[i] .cidr);
          const b = toInt(rows[j] .cidr);
          if (a.start <= b.end && b.start <= a.end) findings.push(error('vcfnet91.vpc.overlap', `${rows[i] .cidr} (${rows[i] .pg}) overlaps ${rows[j] .cidr} (${rows[j] .pg}).`, { source: SRC }));
        }
      }
      if (rows.some((row) => row.mode === 'Public')) {
        findings.push(info('vcfnet91.vpc.public', 'Public subnets take addresses from the project’s external IP blocks.', { remediation: 'Check the project has an external block with room before applying.', source: SRC }));
      }

      const csv = [
        ['port_group', 'vlan', 'vm_count', 'proposed_vpc', 'proposed_subnet', 'cidr', 'access_mode', 'talks_to', 'decision', 'notes'].join(','),
        ...rows.map((row) => [row.pg, '', '', vpc, slugOf(row.pg, 'subnet'), row.cidr, row.mode, '', 'review', ''].map(csvCell).join(',')),
      ].join('\n');

      const vpcBody = {
        display_name: vpc,
        description: `Proposed by ArchToolKit from ${vds} on ${vcenter}. Review before applying.`,
        private_ips: rows.filter((row) => row.mode !== 'Public').map((row) => row.cidr),
      };
      const subnetBodies = Object.fromEntries(
        rows.map((row) => [
          `nsx/subnet-${slugOf(row.pg, 'subnet')}.json`,
          `${JSON.stringify({ display_name: slugOf(row.pg, 'subnet'), ip_addresses: [row.cidr], access_mode: row.mode, _path: `/policy/api/v1/orgs/default/projects/${project}/vpcs/${vpcId}/subnets/${slugOf(row.pg, 'subnet')}` }, null, 2)}\n`,
        ]),
      );

      const pgList = rows.map((row) => `'${sq(row.pg)}'`).join(' ');
      const script = niScript(`Collect the VPC planning facts for ${vds} on ${vcenter} into vpc-planning-observed.csv.`, [
        'OUT=vpc-planning-observed.csv',
        'echo "port_group,vm_count,flows_out,flow_query" > "$OUT"',
        `for PG in ${pgList || "''"}; do`,
        '  [[ -n "$PG" ]] || continue',
        "  VMS=$(ql \"vms where network = '${PG}'\" 1 | jq -r '.entity_list_response.total_count // .search_response_total_hits // error(\"no total in the search response\")')",
        `  Q="flows where source l2 network = '\${PG}' in last ${days} days"`,
        "  FLOWS=$(ql \"$Q\" 1 | jq -r '.entity_list_response.total_count // .search_response_total_hits // error(\"no total in the search response\")')",
        '  printf \'%s,%s,%s,"%s"\\n\' "$PG" "$VMS" "$FLOWS" "$Q" >> "$OUT"',
        '  echo "${PG}: ${VMS} VMs, ${FLOWS} flows out"',
        'done',
        'echo "Written to ${OUT}. Merge it into vpc-planning.csv."',
      ]);

      const queries = [
        `# Paste each into the VCF Operations for Networks search bar. VERIFY the property`,
        '# names (network, source l2 network, destination l2 network) in the search bar',
        '# on your release: the suggestions it offers are the authoritative names.',
        '',
        `vms where vcenter manager = '${vcenter}'`,
        `distributed virtual portgroups where distributed virtual switch = '${vds}'`,
        ...rows.flatMap((row) => [
          `vms where network = '${row.pg}'`,
          `flows where source l2 network = '${row.pg}' and destination l2 network != '${row.pg}' in last ${days} days`,
        ]),
        '',
        '# In 9.1, Plan > VPC Planning does this analysis for a chosen vCenter and VDS and',
        '# exports CSV; use that export to check the numbers above.',
        '',
      ].join('\n');

      const pkg = networksPackage({
        base,
        thing: 'vpc',
        description: `Counts the VMs on, and the flows out of, the ${rows.length} port group(s) planned into VPC ${vpc}.`,
        workflowName: `VPC planning facts ${base}`,
        workflowDescription: `For each port group planned into ${vpc}: the VMs on it and the flows out of it over ${days} days, from the Networks search. Changes nothing; nothing is sent to NSX.`,
        outputs: [{ name: 'observedCsv', type: 'string', description: 'port_group,vm_count,flows_out,flow_query — the rows collect-vpc-facts.sh writes' }],
        script: String.raw`var PORT_GROUPS = ${JSON.stringify(rows.map((row) => row.pg))};
var DAYS = ${days};
${NET_LOGIN}
var rows = ["port_group,vm_count,flows_out,flow_query"];
try {
  for (var i = 0; i < PORT_GROUPS.length; i++) {
    var pg = PORT_GROUPS[i];
    var vms = count("vms where network = '" + pg + "'");
    var q = "flows where source l2 network = '" + pg + "' in last " + DAYS + " days";
    var flows = count(q);
    rows.push(pg + "," + vms + "," + flows + ",\"" + q + "\"");
    System.log(pg + ": " + vms + " VMs, " + flows + " flows out");
  }
} finally {
  core.logoutVcfNetworks(settings.netHost, auth);
}
observedCsv = rows.join("\n") + "\n";
summary = core.audit(null, { vpc: ${JSON.stringify(vpc)}, portGroups: PORT_GROUPS.length });
core.notify(settings.webhook, summary);`,
      });

      return {
        platform: NETWORKS,
        title: `VPC plan "${vpc}" from ${rows.length} port group${rows.length === 1 ? '' : 's'} on ${vds}`,
        effect: 'read',
        trigger: { kind: 'manual', detail: 'Run while planning, and again just before the change to confirm nothing has moved.', worstCase: 'as often as someone runs it' },
        scope: {
          what: `Port groups on ${vds} (${vcenter}), read from Networks. The NSX payloads are files for review; nothing is sent to NSX.`,
          decidedBy: rows.map((row) => `${row.pg} → ${row.cidr} (${row.mode}).`),
          ifWrong: 'A VPC plan that misses a port group or a flow. It is caught at review, not in production, because nothing here applies it.',
        },
        guardrails: [
          { rule: 'Overlapping CIDRs are an error before anything is written', because: 'Two subnets with overlapping ranges in one VPC is rejected by NSX at best and a routing incident at worst.' },
          { rule: 'Nothing is sent to NSX', because: 'A VPC migration moves VMs between networks; that is a change with its own window, not a side effect of planning.' },
        ],
        dryRun: [`Everything here reads. Run the workflow VPC planning facts ${base} (or scripts/collect-vpc-facts.sh) and paste search-queries.txt into the search bar.`],
        undo: ['Nothing to undo.'],
        told: ['Whoever reviews vpc-planning.csv; the webhook in the workflow settings, if set.'],
        requires: ['VCF Operations for Networks 9.1 with the vCenter and NSX data sources, and flow collection on the VDS.', 'An NSX project with VPCs enabled, and address blocks for the CIDRs.', 'jq and curl for the script.', NET_PACKAGE_REQUIRES],
        files: {
          ...pkg.files,
          'vpc-planning.csv': `${csv}\n`,
          'search-queries.txt': queries,
          'scripts/collect-vpc-facts.sh': script,
          'IMPORT.md': importMd({
            title: `the VPC plan "${vpc}"`,
            intro: ['An Orchestrator package that collects the facts from VCF Operations for Networks, the same collection as a script, and review files. Nothing here is imported into NSX: the payloads under nsx/ are for review.'],
            steps: [
              ...packageSteps(pkg, 'collects the VPC planning facts'),
              {
                heading: 'What the workflow calls',
                files: [],
                how: ['POST /api/ni/auth/token, then for each port group POST /api/ni/search/ql {query, size: 1} twice (VMs on it, flows out of it), then DELETE /api/ni/auth/token. Its observedCsv output is what scripts/collect-vpc-facts.sh writes to vpc-planning-observed.csv; merge it into vpc-planning.csv.'],
                verify: ['the search-bar property names (network, source l2 network) on your release: the suggestions the search bar offers are the authoritative names.'],
              },
              { heading: 'Or: the script', files: ['scripts/collect-vpc-facts.sh', 'search-queries.txt'], how: ['VCFNET_HOST, VCFNET_USER and VCFNET_PASSWORD_FILE set, ./scripts/collect-vpc-facts.sh writes vpc-planning-observed.csv. search-queries.txt holds the same questions for the search bar.'] },
              { heading: 'Review, then apply by hand', files: ['vpc-planning.csv', 'nsx/APPLY.txt'], how: ['vpc-planning.csv is the plan to review. The files under nsx/ name the NSX Policy API path each would be PATCHed to; nsx/APPLY.txt says what to check before that. Applying them is a change with its own window, outside this kit.'] },
            ],
          }),
          [`nsx/vpc-${vpcId}.json`]: `${JSON.stringify({ ...vpcBody, _path: `/policy/api/v1/orgs/default/projects/${project}/vpcs/${vpcId}` }, null, 2)}\n`,
          ...subnetBodies,
          'nsx/APPLY.txt': [
            'These are review payloads. Each file names the NSX Policy API path it would be',
            'PATCHed to in _path; remove _path before sending.',
            '',
            'VERIFY against your NSX 9 API reference before use:',
            '  PATCH /policy/api/v1/orgs/default/projects/{project}/vpcs/{vpc}',
            '  PATCH /policy/api/v1/orgs/default/projects/{project}/vpcs/{vpc}/subnets/{subnet}',
            '  - whether private_ips is still set on the VPC or on its connectivity profile;',
            '  - the access_mode enum (Public, Private, Isolated, Private_TGW in recent releases);',
            '  - the connectivity profile attachment, which is not in these payloads.',
            '',
          ].join('\n'),
          [`${base}.txt`]: `VPC ${vpc} in project ${project}, from ${vds} on ${vcenter}. Generated by ArchToolKit.\n`,
        },
        notes: [
          'CONFIRMED in the 9.1 release notes: VPC planning in VCF Operations for Networks gives guidance for moving from vSphere networking to VPCs, after selecting a vCenter and a VDS, with CSV export.',
          'VERIFY: the NSX VPC and subnet field names, and the search-bar property names in the queries.',
        ],
        findings,
      };
    },
  }),

  // -------------------------------------------------------------------------
  automationBlueprint({
    id: 'vcfnet91_migration_waves',
    platform: NETWORKS,
    label: 'Generate migration groups and waves from flows (9.1)',
    group: 'VCF 9.1 planning',
    description:
      'Applications that talk to each other move together. From application-to-application flow counts, this groups the chatty ones, packs the groups into waves under a VM cap — smallest first, as the Migration page’s wave 1 — and exports the plan as CSV, plus a portfolio CSV the Migration page imports. A script pulls the flow counts from Networks.',
    inputs: [
      {
        id: 'dependencies',
        label: 'Application flows',
        control: 'textarea',
        default: 'orders-web -> orders-app : 12000\norders-app -> orders-db : 9000\norders-app -> payments : 300\nhr-portal -> hr-db : 4000\nreporting -> orders-db : 40\nwiki -> wiki-db : 800',
        hint: 'One per line: source -> destination : flow count (from collect-app-flows.sh or the 9.1 migration planning export)',
      },
      { id: 'sizes', label: 'VMs per application', control: 'textarea', default: 'orders-web = 6\norders-app = 4\norders-db = 2\npayments = 3\nhr-portal = 2\nhr-db = 1\nreporting = 2\nwiki = 1\nwiki-db = 1', hint: 'app = VM count; an app not listed counts as 1' },
      { id: 'threshold', label: 'Move together above (flows)', control: 'number', default: 500, min: 1, max: 100000000 },
      { id: 'cap', label: 'VMs per wave, at most', control: 'number', default: 15, min: 1, max: 10000 },
      { id: 'days', label: 'Flows over the last (days)', control: 'number', default: 30, min: 1, max: 90 },
    ],
    automation: (values                 , name        )             => {
      const { deps, bad } = parseDependencies(str(values, 'dependencies', ''));
      const sizes = parseSizes(str(values, 'sizes', ''));
      const threshold = num(values, 'threshold', 500);
      const cap = num(values, 'cap', 15);
      const days = num(values, 'days', 30);
      const base = slugOf(name || 'migration-waves', 'migration-waves');
      const apps = [...new Set([...deps.flatMap((d) => [d.from, d.to]), ...sizes.keys()])].sort();
      const plan = planWaves(apps, deps, sizes, threshold, cap);

      const findings            = [];
      for (const line of bad) findings.push(error('vcfnet91.waves.bad-line', `"${line}" is not "source -> destination : count".`, { source: SRC }));
      if (apps.length === 0) findings.push(error('vcfnet91.waves.empty', 'No applications to plan.', { source: SRC }));
      if (plan.oversized.length > 0) {
        findings.push(
          warning('vcfnet91.waves.oversized', `Group${plan.oversized.length === 1 ? '' : 's'} ${plan.oversized.join(', ')} alone exceed${plan.oversized.length === 1 ? 's' : ''} the ${cap}-VM cap and ha${plan.oversized.length === 1 ? 's' : 've'} a wave to itself.`, {
            remediation: 'Either raise the cap for that wave, or raise the threshold so weaker links stop pulling applications together — and accept their traffic crossing the interconnect during the move.',
            source: SRC,
          }),
        );
      }
      if (plan.crossWave.length > 0) {
        findings.push(
          info('vcfnet91.waves.cross', `${plan.crossWave.length} dependenc${plan.crossWave.length === 1 ? 'y crosses' : 'ies cross'} waves: ${plan.crossWave.map((d) => `${d.from} → ${d.to} (${d.weight})`).join('; ')}.`, {
            remediation: 'These flows run over HCX network extension or the WAN between waves. Check latency tolerance for each before committing the plan.',
            source: SRC,
          }),
        );
      }

      const groupOf = new Map                ();
      for (const group of plan.groups) for (const app of group.apps) groupOf.set(app, group.id);
      const waveOfGroup = new Map                ();
      for (const wave of plan.waves) for (const id of wave.groups) waveOfGroup.set(id, wave.wave);

      const wavesCsv = [
        'wave,group,application,vms,depends_on,depended_on_by',
        ...plan.waves.flatMap((wave) =>
          wave.groups.flatMap((id) =>
            plan.groups[id - 1] .apps.map((app) =>
              [
                `Wave ${wave.wave}`,
                `G${id}`,
                app,
                sizes.get(app) ?? 1,
                deps.filter((d) => d.from === app).map((d) => d.to).join(' '),
                deps.filter((d) => d.to === app).map((d) => d.from).join(' '),
              ]
                .map(csvCell)
                .join(','),
            ),
          ),
        ),
      ].join('\n');

      const portfolio = [
        CSV_COLUMNS.join(','),
        ...apps.map((app) =>
          CSV_COLUMNS.map((column) => {
            if (column === 'name') return csvCell(app);
            if (column === 'integrationCount') return String(deps.filter((d) => d.from === app || d.to === app).length);
            if (column === 'notes') return csvCell(`VCF Operations for Networks: group G${groupOf.get(app)}, network wave ${waveOfGroup.get(groupOf.get(app) ?? 0) ?? '?'}`);
            return '';
          }).join(','),
        ),
      ].join('\n');

      const collect = niScript(`Pull application-to-application flow counts over ${days} days into app-flows.txt, in the format this blueprint reads.`, [
        '# Applications as defined in Networks (GET /groups/applications).',
        "APPS=$(ni GET '/groups/applications?size=1000' | jq -r '(.results // error(\"no results in /groups/applications\"))[].entity_id')",
        '[[ -n "$APPS" ]] || { echo "No applications defined in Networks: nothing to measure." >&2; exit 2; }',
        ': > app-flows.txt',
        'for ID in $APPS; do',
        "  SRC=$(ni POST /entities/fetch --data \"$(jq -n --arg id \"$ID\" '{entity_ids: [{entity_type: \"Application\", entity_id: $id}]}')\" | jq -r '.results[0].entity.name // empty')",
        '  [[ -n "$SRC" ]] || continue',
        "  for DST_ID in $APPS; do",
        '    [[ "$DST_ID" == "$ID" ]] && continue',
        "    DST=$(ni POST /entities/fetch --data \"$(jq -n --arg id \"$DST_ID\" '{entity_ids: [{entity_type: \"Application\", entity_id: $id}]}')\" | jq -r '.results[0].entity.name // empty')",
        `    N=$(ql "flows where source application = '\${SRC}' and destination application = '\${DST}' in last ${days} days" 1 | jq -r '.entity_list_response.total_count // .search_response_total_hits // error(\"no total in the search response\")')`,
        '    (( N > 0 )) && echo "${SRC} -> ${DST} : ${N}" | tee -a app-flows.txt',
        '  done',
        'done',
        'echo "Paste app-flows.txt into the Application flows box."',
      ]);

      // The whole job in Orchestrator: the flow counts from Networks, then the
      // same grouping and packing as planWaves (union-find over flows at or above
      // the threshold, groups smallest first into waves under the cap).
      const pkg = networksPackage({
        base,
        thing: 'waves',
        description: `Pulls application-to-application flow counts over ${days} days and plans migration waves from them.`,
        workflowName: `Migration waves ${base}`,
        workflowDescription: `Reads the applications defined in Networks and the flows between each pair over ${days} days, groups applications that talk at or above the threshold, and packs the groups into waves under the VM cap, smallest first. Changes nothing.`,
        outputs: [
          { name: 'appFlows', type: 'string', description: 'source -> destination : count, one per line — the blueprint\'s Application flows format' },
          { name: 'wavesCsv', type: 'string', description: 'wave,group,application,vms,depends_on,depended_on_by' },
          { name: 'crossWave', type: 'string', description: 'Dependencies split across waves, one per line' },
        ],
        extra: [
          { name: 'threshold', type: 'number', value: threshold, description: 'Applications with at least this many flows between them move together' },
          { name: 'vmCap', type: 'number', value: cap, description: 'VMs per wave, at most' },
          { name: 'days', type: 'number', value: days, description: 'Flows over the last this many days' },
          { name: 'sizes', type: 'Array/string', value: [...sizes.entries()].map(([app, n]) => `${app} = ${n}`), description: 'app = VM count; an application not listed counts as 1' },
        ],
        script: String.raw`var THRESHOLD = Number(settings.threshold);
var CAP = Number(settings.vmCap);
var DAYS = Number(settings.days);
${NET_LOGIN}
var names = [];
var deps = [];
try {
  // Applications as defined in Networks (GET /groups/applications), every page.
  var ids = [];
  var cursor = "";
  for (var page = 0; page < 1000; page++) {
    var b = core.http("GET", ni + "/groups/applications?size=1000" + (cursor ? "&cursor=" + encodeURIComponent(cursor) : ""), auth, null, SAFE).body || {};
    if (!b.results) throw new Error("GET /api/ni/groups/applications returned no results list (VERIFY the response on your release).");
    for (var i = 0; i < b.results.length; i++) ids.push({ entity_type: "Application", entity_id: String(b.results[i].entity_id) });
    if (!b.cursor || String(b.cursor) === cursor || b.results.length === 0 || (b.total_count !== undefined && b.total_count !== null && ids.length >= Number(b.total_count))) break;
    cursor = String(b.cursor);
  }
  if (ids.length === 0) throw new Error("No applications are defined in Networks: nothing to measure.");
  // Their names, 100 at a time.
  for (var at = 0; at < ids.length; at += 100) {
    var f = core.http("POST", ni + "/entities/fetch", auth, { entity_ids: ids.slice(at, at + 100) }, SAFE).body || {};
    if (!f.results) throw new Error("POST /api/ni/entities/fetch returned no results list.");
    for (var r = 0; r < f.results.length; r++) if (f.results[r].entity && f.results[r].entity.name) names.push(String(f.results[r].entity.name));
  }
  // One count per ordered pair: every flow from one application to another.
  for (var s = 0; s < names.length; s++) {
    for (var d = 0; d < names.length; d++) {
      if (s === d) continue;
      var n = count("flows where source application = '" + names[s] + "' and destination application = '" + names[d] + "' in last " + DAYS + " days");
      if (n > 0) deps.push({ from: names[s], to: names[d], weight: n });
    }
  }
} finally {
  core.logoutVcfNetworks(settings.netHost, auth);
}
var flowLines = [];
for (var x = 0; x < deps.length; x++) flowLines.push(deps[x].from + " -> " + deps[x].to + " : " + deps[x].weight);
appFlows = flowLines.join("\n") + (flowLines.length ? "\n" : "");

var sizes = {};
var given = settings.sizes || [];
for (var g = 0; g < given.length; g++) {
  var line = String(given[g]);
  var eq = line.lastIndexOf("=");
  if (eq < 0) continue;
  var v = Number(line.substring(eq + 1).replace(/^\s+|\s+$/g, ""));
  if (isFinite(v) && v >= 0) sizes[line.substring(0, eq).replace(/^\s+|\s+$/g, "")] = v;
}
function vmsOf(app) { return sizes.hasOwnProperty(app) ? sizes[app] : 1; }
var apps = [];
function add(app) { if (apps.indexOf(app) < 0) apps.push(app); }
for (var a1 = 0; a1 < deps.length; a1++) { add(deps[a1].from); add(deps[a1].to); }
for (var key in sizes) if (sizes.hasOwnProperty(key)) add(key);
for (var a2 = 0; a2 < names.length; a2++) add(names[a2]);
apps.sort();
var parent = {};
for (var p = 0; p < apps.length; p++) parent[apps[p]] = apps[p];
function find(item) {
  var root = item;
  while (parent[root] !== root) root = parent[root];
  parent[item] = root;
  return root;
}
for (var e = 0; e < deps.length; e++) {
  if (deps[e].weight >= THRESHOLD) {
    var ra = find(deps[e].from), rb = find(deps[e].to);
    if (ra !== rb) parent[ra] = rb;
  }
}
var byRoot = {};
var roots = [];
for (var q = 0; q < apps.length; q++) {
  var root = find(apps[q]);
  if (!byRoot.hasOwnProperty(root)) { byRoot[root] = []; roots.push(root); }
  byRoot[root].push(apps[q]);
}
var lists = [];
for (var t = 0; t < roots.length; t++) {
  var members = byRoot[roots[t]].slice().sort();
  var total = 0;
  for (var u = 0; u < members.length; u++) total += vmsOf(members[u]);
  lists.push({ apps: members, vms: total });
}
lists.sort(function (l, m) { return l.vms - m.vms || l.apps[0].localeCompare(m.apps[0]); });
var waves = [];
var waveOf = {};
for (var w = 0; w < lists.length; w++) {
  var last = waves.length ? waves[waves.length - 1] : null;
  if (last && last.vms + lists[w].vms <= CAP) { last.groups.push(w + 1); last.vms += lists[w].vms; }
  else waves.push({ wave: waves.length + 1, groups: [w + 1], vms: lists[w].vms });
  for (var y = 0; y < lists[w].apps.length; y++) waveOf[lists[w].apps[y]] = waves[waves.length - 1].wave;
}
function cell(text) { var c = String(text); return /[",\n]/.test(c) ? "\"" + c.split("\"").join("\"\"") + "\"" : c; }
var rows = ["wave,group,application,vms,depends_on,depended_on_by"];
for (var wv = 0; wv < waves.length; wv++) {
  for (var gi = 0; gi < waves[wv].groups.length; gi++) {
    var id = waves[wv].groups[gi];
    var groupApps = lists[id - 1].apps;
    for (var ga = 0; ga < groupApps.length; ga++) {
      var app = groupApps[ga], to = [], from = [];
      for (var z = 0; z < deps.length; z++) {
        if (deps[z].from === app) to.push(deps[z].to);
        if (deps[z].to === app) from.push(deps[z].from);
      }
      rows.push([cell("Wave " + waves[wv].wave), cell("G" + id), cell(app), cell(vmsOf(app)), cell(to.join(" ")), cell(from.join(" "))].join(","));
    }
  }
}
wavesCsv = rows.join("\n") + "\n";
var split = [];
for (var c2 = 0; c2 < deps.length; c2++) if (waveOf[deps[c2].from] !== waveOf[deps[c2].to]) split.push(deps[c2].from + " -> " + deps[c2].to + " (" + deps[c2].weight + ")");
crossWave = split.join("\n");
for (var o = 0; o < split.length; o++) System.log("Crosses waves: " + split[o]);
var oversized = 0;
for (var ov = 0; ov < lists.length; ov++) if (lists[ov].vms > CAP) oversized++;
if (oversized > 0) System.warn(oversized + " group(s) alone exceed the " + CAP + "-VM cap and have a wave to themselves.");
summary = core.audit(null, { applications: apps.length, groups: lists.length, waves: waves.length, crossWave: split.length, oversized: oversized });
core.notify(settings.webhook, summary);`,
      });

      return {
        platform: NETWORKS,
        title: `Migration waves — ${plan.groups.length} groups in ${plan.waves.length} waves (≤${cap} VMs each)`,
        effect: 'read',
        trigger: { kind: 'manual', detail: 'Run while planning; re-run collect-app-flows.sh before each wave, since flows change.', worstCase: 'one search per application pair per run' },
        scope: {
          what: `${apps.length} applications, grouped by flows of ${threshold} or more over ${days} days.`,
          decidedBy: ['The applications defined in Networks, and their names.', `The ${threshold}-flow threshold that decides who moves together.`, `The ${cap}-VM cap per wave.`],
          ifWrong: 'Two applications that talk heavily land in different waves, and their traffic runs over the interconnect for weeks. The cross-wave list is where that shows.',
        },
        guardrails: [
          { rule: 'Every dependency split across waves is listed', because: 'A plan that hides the split is how a database ends up a WAN hop from its application for a month.' },
          { rule: 'Groups larger than the cap are flagged, not split', because: 'Splitting a tightly coupled group to meet a number moves the problem, it does not solve it.' },
        ],
        dryRun: [`It only reads. The workflow Migration waves ${base} (and scripts/collect-app-flows.sh) makes one search per application pair; on a large estate run it out of hours.`],
        undo: ['Nothing to undo.'],
        told: ['The migration team, through waves.csv (or the workflow\'s wavesCsv output); the Migration page, through portfolio-import.csv.'],
        requires: ['Applications defined in VCF Operations for Networks (see "Define an application and its tiers").', 'Flow collection for long enough to cover monthly jobs: 30 days is the minimum worth trusting.', 'jq and curl for the script.', NET_PACKAGE_REQUIRES],
        files: {
          ...pkg.files,
          'waves.csv': `${wavesCsv}\n`,
          'portfolio-import.csv': `${portfolio}\n`,
          'scripts/collect-app-flows.sh': collect,
          'IMPORT.md': importMd({
            title: 'the migration waves',
            intro: ['An Orchestrator package that pulls the flows from VCF Operations for Networks and plans the waves itself, the same pull as a script, and the plan for the flows typed in here. portfolio-import.csv is imported on the Migration page, not into a VCF product.'],
            steps: [
              ...packageSteps(pkg, 'pulls the flows and plans the waves'),
              {
                heading: 'What the workflow calls',
                files: [],
                how: [`POST /api/ni/auth/token; GET /api/ni/groups/applications?size=1000 (following cursor); POST /api/ni/entities/fetch for their names, 100 at a time; POST /api/ni/search/ql once per ordered pair of applications ("flows where source application = … and destination application = … in last ${days} days"); DELETE /api/ni/auth/token. Its wavesCsv output is waves.csv for the measured flows; appFlows can be pasted into the Application flows box here.`],
                verify: ['the "source application" and "destination application" search properties on your release.'],
              },
              { heading: 'Or: the script', files: ['scripts/collect-app-flows.sh'], how: ['./scripts/collect-app-flows.sh writes app-flows.txt in the format of the Application flows box; paste it there and download again.'] },
              { heading: 'The plan for the flows typed in here', files: ['waves.csv', 'portfolio-import.csv', `${base}.json`], how: ['waves.csv is the plan. portfolio-import.csv has the Migration page\'s import columns: import it there (Migration → Import).'] },
            ],
          }),
          [`${base}.json`]: `${JSON.stringify({ threshold, cap, days, groups: plan.groups, waves: plan.waves, crossWave: plan.crossWave }, null, 2)}\n`,
        },
        notes: [
          'portfolio-import.csv has the Migration page’s import columns; the network group and wave are in notes. The Migration page decides its own wave from risk and readiness — the two are complementary: that one says how hard, this one says what must move together.',
          'CONFIRMED in the 9.1 release notes: migration planning in Networks generates waves and groups automatically. Compare its result with this one; where they disagree, the flows threshold is usually why.',
          'VERIFY: GET /groups/applications, POST /entities/fetch and the "source application" / "destination application" search properties against your release.',
        ],
        findings,
      };
    },
  }),

  // -------------------------------------------------------------------------
  automationBlueprint({
    id: 'vcfnet91_assessment',
    platform: NETWORKS,
    label: 'Network assessment report, and VKS/Antrea IPFIX checklist (9.1)',
    group: 'VCF 9.1 planning',
    description:
      'The numbers behind a Network Assessment and Value conversation — east-west against north-south, traffic that hairpins through a physical router, flows with no firewall rule, VMs on VLAN-backed port groups — pulled from Networks into a CSV, and the checklist for getting pod-level flows from VKS clusters running Antrea into the same collector.',
    inputs: [
      { id: 'days', label: 'Over the last (days)', control: 'number', default: 7, min: 1, max: 30 },
      { id: 'include_vks', label: 'Include the VKS/Antrea IPFIX checklist', control: 'toggle', default: true },
      { id: 'collector', label: 'Networks collector (IPFIX target)', control: 'text', default: 'vcfnet-collector01.example.com', showWhen: { input: 'include_vks', equals: ['true'] } },
    ],
    automation: (values                 , name        )             => {
      const days = num(values, 'days', 7);
      const vks = bool(values, 'include_vks', true);
      const collector = str(values, 'collector', '');
      const base = slugOf(name || 'network-assessment', 'network-assessment');

      const findings            = [];
      if (days < 7) findings.push(warning('vcfnet91.assess.short', `${days} days misses weekly jobs.`, { remediation: 'Seven days is the shortest window that shows a whole week’s pattern.', source: SRC }));

      const questions                              = [
        ['All flows', `flows in last ${days} days`],
        ['East-west', `flows where Flow Type = 'East-West' in last ${days} days`],
        ['North-south (internet)', `flows where Flow Type = 'Internet' in last ${days} days`],
        ['Routed through a physical router', `flows where Flow Type = 'Routed' and Flow Type = 'Physical' in last ${days} days`],
        ['Same host', `flows where Flow Type = 'Same Host' in last ${days} days`],
        ['No firewall rule seen', `flows where firewall rule is not set in last ${days} days`],
        ['VMs', 'vms'],
        ['VMs on VLAN-backed port groups', "vms where network type = 'VLAN'"],
      ];
      const script = niScript(`Network assessment counts over ${days} days into ${base}.csv.`, [
        `OUT=${base}.csv`,
        'echo "measure,count,query" > "$OUT"',
        'FAILED=0',
        ...questions.flatMap(([label, query]) => [
          `Q='${sq(query)}'`,
          "if N=$(ql \"$Q\" 1 | jq -r '.entity_list_response.total_count // .search_response_total_hits // \"?\"'); then :; else N=\"?\"; FAILED=1; fi",
          `printf '%s,%s,"%s"\\n' '${sq(label)}' "$N" "$Q" >> "$OUT"`,
          `echo '${sq(label)}': "$N"`,
        ]),
        'echo "Written to ${OUT}."',
        '(( FAILED )) && echo "Some searches failed: paste them into the search bar to see why (VERIFY the property names)." >&2',
        'exit $FAILED',
      ]);

      const checklist = [
        `VKS clusters with Antrea — IPFIX to VCF Operations for Networks 9.1 (collector ${collector || '<set>'})`,
        '',
        '[ ] Networks 9.1 or later: container IPFIX flows from VKS clusters with Antrea are new in 9.1.',
        '[ ] The VKS cluster uses Antrea as its CNI (the default for VKS).',
        '[ ] Antrea FlowExporter is enabled. On VKS this is set through the AntreaConfig',
        '    object for the cluster, not by editing the antrea-agent ConfigMap directly:',
        '      featureGates: FlowExporter: true',
        `      flowExporter / flowCollectorAddr: "${collector || '<collector>'}:4739:udp"`,
        '    VERIFY the AntreaConfig field names and the collector port for your VKS and',
        '    Antrea versions (4739 is the IPFIX standard port; check what the collector listens on).',
        '[ ] Node and pod CIDRs of the cluster can reach the collector on that port.',
        '[ ] The cluster is added as a data source in Networks (Kubernetes / VKS) so flows',
        '    are attributed to pods and namespaces rather than to node IPs.',
        '[ ] After an hour, search: flows where kubernetes cluster = \'<cluster>\' — non-zero means it works.',
        '',
      ].join('\n');

      const pkg = networksPackage({
        base,
        thing: 'assessment',
        description: `Network assessment counts over ${days} days.`,
        workflowName: `Network assessment ${base}`,
        workflowDescription: `Runs the ${questions.length} assessment searches (east-west, north-south, hairpinned, no firewall rule, VLAN-backed VMs) as counts and returns them as CSV. Changes nothing; fails when a search fails, rather than report it as zero.`,
        outputs: [
          { name: 'assessmentCsv', type: 'string', description: 'measure,count,query — the CSV the script writes' },
          { name: 'failedSearches', type: 'number', description: 'Searches that failed (their count is "?")' },
        ],
        script: String.raw`var QUESTIONS = ${JSON.stringify(questions)};
${NET_LOGIN}
var rows = ["measure,count,query"];
var failed = 0;
try {
  for (var i = 0; i < QUESTIONS.length; i++) {
    var n = "?";
    try {
      n = String(count(QUESTIONS[i][1]));
    } catch (e) {
      failed++;
      System.warn("Search failed: " + QUESTIONS[i][0] + ": " + e);
    }
    rows.push(QUESTIONS[i][0] + "," + n + ",\"" + QUESTIONS[i][1] + "\"");
    System.log(QUESTIONS[i][0] + ": " + n);
  }
} finally {
  core.logoutVcfNetworks(settings.netHost, auth);
}
assessmentCsv = rows.join("\n") + "\n";
failedSearches = failed;
summary = core.audit(null, { searches: QUESTIONS.length, failed: failed });
core.notify(settings.webhook, summary);
// A zero from a query that did not run would read as "no hairpinned traffic".
if (failed > 0) throw new Error(failed + " search(es) failed and show \"?\": paste them into the search bar to see why (VERIFY the property names).");`,
      });

      return {
        platform: NETWORKS,
        title: `Network assessment — ${days}-day flow profile`,
        effect: 'read',
        trigger: { kind: 'manual', detail: 'Before a VCF networking design discussion, and after a change to measure it.', worstCase: `${questions.length} searches per run` },
        scope: {
          what: 'Counts of flows and VMs from Networks. Reads only.',
          decidedBy: ['The data sources Networks has, and how long it has held flows.', `The ${days}-day window.`],
          ifWrong: 'An assessment built on a partial view: a source not collecting makes east-west look smaller than it is. Check data source health first.',
        },
        guardrails: [
          { rule: 'Every search is a count, not a flow dump', because: 'Pulling every flow for a week is a heavy query on the platform and a large file nobody reads.' },
          { rule: 'A failed search is shown as "?" and the script exits 1', because: 'A zero from a query that did not run would read as "no hairpinned traffic".' },
        ],
        dryRun: ['It only reads. Paste any of the queries in the script into the search bar to see the flows behind a number.'],
        undo: ['Nothing to undo.'],
        told: [`Whoever runs it; ${base}.csv (the workflow's assessmentCsv output) is the output; the webhook in the workflow settings, if set.`],
        requires: ['VCF Operations for Networks with vCenter and NSX data sources collecting.', 'jq and curl for the script.', NET_PACKAGE_REQUIRES, ...(vks ? ['For the VKS checklist: access to the VKS cluster configuration.'] : [])],
        files: {
          ...pkg.files,
          [`scripts/${base}.sh`]: script,
          ...(vks ? { 'vks-antrea-ipfix-checklist.txt': checklist } : {}),
          'IMPORT.md': importMd({
            title: 'the network assessment',
            intro: ['An Orchestrator package that runs the assessment searches against VCF Operations for Networks, and the same searches as a script.'],
            steps: [
              ...packageSteps(pkg, 'runs the assessment'),
              {
                heading: 'What the workflow calls',
                files: [],
                how: [`POST /api/ni/auth/token; POST /api/ni/search/ql {query, size: 1} once per measure (${questions.length}); DELETE /api/ni/auth/token. assessmentCsv is ${base}.csv.`],
                verify: ['the Flow Type values and the "firewall rule" and "network type" properties in the search bar of your release.'],
              },
              { heading: 'Or: the script', files: [`scripts/${base}.sh`], how: [`./scripts/${base}.sh writes ${base}.csv and exits 1 when a search failed.`] },
              ...(vks ? [{ heading: 'The VKS/Antrea IPFIX checklist', files: ['vks-antrea-ipfix-checklist.txt'], how: ['For a person: what to set on each VKS cluster so its pod flows reach the collector.'] }] : []),
            ],
          }),
        },
        notes: [
          'CONFIRMED in the 9.1 release notes: Network Assessment and Value (evaluate the current network and the value of VCF networking) and container IPFIX from VKS clusters with Antrea. The built-in assessment in the interface is the fuller version; this script is the repeatable, versioned subset.',
          'VERIFY: the Flow Type values and the "firewall rule" and "network type" properties in the search bar of your release.',
        ],
        findings,
      };
    },
  }),

  // -------------------------------------------------------------------------
  automationBlueprint({
    id: 'vcfnet91_health',
    platform: NETWORKS,
    label: 'Infrastructure problems report for admins (9.1)',
    group: 'VCF 9.1 operations',
    description:
      'The open problem events Networks has raised about the infrastructure — appliances, NSX, edges, host networking — as a daily report that exits non-zero when anything at or above the chosen severity is open. The 9.1 health dashboards show the same thing to someone looking; this is for when nobody is.',
    inputs: [
      {
        id: 'severity',
        label: 'Report at or above',
        control: 'select',
        options: [
          { value: 'CRITICAL', label: 'Critical' },
          { value: 'MODERATE', label: 'Moderate' },
          { value: 'WARNING', label: 'Warning' },
          { value: 'INFO', label: 'Info' },
        ],
        default: 'MODERATE',
      },
      { id: 'hours', label: 'Raised in the last (hours)', control: 'number', default: 24, min: 1, max: 720 },
      { id: 'schedule', label: 'Emit a crontab line', control: 'toggle', default: true },
    ],
    automation: (values                 , name        )             => {
      const severity = str(values, 'severity', 'MODERATE');
      const hours = num(values, 'hours', 24);
      const schedule = bool(values, 'schedule', true);
      const base = slugOf(name || 'vcfnet-problems', 'vcfnet-problems');
      const order = ['INFO', 'WARNING', 'MODERATE', 'CRITICAL'];
      const include = order.slice(order.indexOf(severity));

      const findings            = [];
      if (severity === 'INFO') findings.push(warning('vcfnet91.health.info', 'Reporting from Info upwards will fail every day.', { remediation: 'A report that always exits 1 is ignored within a week. Start at Moderate.', source: SRC }));

      const script = niScript(`Open infrastructure problems in VCF Operations for Networks, ${severity} and above, raised in the last ${hours} hours. Exits 1 when there are any.`, [
        'NOW=$(date +%s)',
        `START=$(( NOW - ${hours} * 3600 ))`,
        '# Open problem events in the window: GET /entities/problems (9.x API reference:',
        '# size, cursor, start_time, end_time, event_status), every page, into files: the',
        '# id list of a bad day is over the 128 KB limit on one argument. A response',
        '# without results is an error, not "no problems".',
        'WORK=$(umask 077; mktemp -d "${TMPDIR:-/tmp}/atk-work.XXXXXX")',
        'trap \'rm -rf "$WORK" "${NI_AUTH:-}"\' EXIT',
        'CURSOR=""',
        ': > "$WORK/ids.items"',
        'for _ in $(seq 1 1000); do',
        '  Q="size=1000&event_status=open&start_time=${START}&end_time=${NOW}"',
        '  [[ -n "$CURSOR" ]] && Q="${Q}&cursor=$(jq -rn --arg c "$CURSOR" \'$c | @uri\')"',
        '  ni GET "/entities/problems?${Q}" > "$WORK/page.json"',
        '  jq -e \'has("results")\' "$WORK/page.json" >/dev/null || { echo "GET /entities/problems returned no results list — VERIFY the request against your release." >&2; exit 2; }',
        '  jq -c \'.results[] | {entity_type: (.entity_type // "ProblemEvent"), entity_id} + (if .time then {time} else {} end)\' "$WORK/page.json" >> "$WORK/ids.items"',
        '  NEXT=$(jq -r \'.cursor // empty\' "$WORK/page.json")',
        '  [[ -n "$NEXT" && "$NEXT" != "$CURSOR" && $(jq \'.results | length\' "$WORK/page.json") -gt 0 ]] || break',
        '  CURSOR="$NEXT"',
        'done',
        'COUNT=$(grep -c . "$WORK/ids.items" || true)',
        'echo "${COUNT} open problem event(s) in the window"',
        '(( COUNT == 0 )) && exit 0',
        '',
        '# Fetch the details, 100 at a time, through files (POST /entities/problems/fetch).',
        ': > "$WORK/raw.items"',
        'split -l 100 "$WORK/ids.items" "$WORK/batch."',
        'for b in "$WORK"/batch.*; do',
        '  jq -s \'{entity_ids: .}\' "$b" > "$WORK/fetch.json"',
        '  ni POST /entities/problems/fetch --data @"$WORK/fetch.json" | jq -c \'(.results // error("no results in /entities/problems/fetch"))[]\' >> "$WORK/raw.items"',
        'done',
        `jq -s '{results: .}' "$WORK/raw.items" > ${base}-raw.json`,
        `jq -r --argjson keep '${JSON.stringify(include)}' '`,
        '  [.results[]?.entity | select(((.severity // "") | ascii_upcase) as $s | $keep | index($s))]',
        '  | sort_by(.severity) | .[]',
        '  | "\\(.severity)\\t\\(.name // .problem_type // "?")\\t\\(((.anchor_entities // []) | map(.entity_id) | join(" ")))"',
        `' ${base}-raw.json | tee ${base}.tsv`,
        `N=$(wc -l < ${base}.tsv)`,
        `echo "\${N} at ${severity} or above"`,
        '(( N == 0 )) || exit 1',
      ]);

      const pkg = networksPackage({
        base,
        thing: 'problems',
        description: `Open infrastructure problems, ${severity} and above, raised in the last ${hours} hours.`,
        workflowName: `Networks problems ${base}`,
        workflowDescription: `Lists the open problem events raised in the last ${hours} hours (GET /api/ni/entities/problems, every page), fetches their details 100 at a time, and reports those at ${severity} or above. Changes nothing; fails when there are any, so a schedule shows it.`,
        outputs: [
          { name: 'problemsTsv', type: 'string', description: 'severity, name, anchor entity ids — one line per problem' },
          { name: 'problemCount', type: 'number', description: `Open problems at ${severity} or above` },
        ],
        extra: [
          { name: 'hours', type: 'number', value: hours, description: 'Raised in the last this many hours' },
          { name: 'failWhenFound', type: 'boolean', value: true, description: 'Fail the run when anything at or above the severity is open' },
        ],
        script: String.raw`var KEEP = ${JSON.stringify(include)};
var FLOOR = ${JSON.stringify(severity)};
${NET_LOGIN}
var now = Math.floor(new Date().getTime() / 1000);
var start = now - Number(settings.hours) * 3600;
var ids = [];
var found = [];
try {
  // Every page of open problem events in the window: a response without results
  // is an error, not "no problems".
  var cursor = "";
  for (var page = 0; page < 1000; page++) {
    var b = core.http("GET", ni + "/entities/problems?size=1000&event_status=open&start_time=" + start + "&end_time=" + now + (cursor ? "&cursor=" + encodeURIComponent(cursor) : ""), auth, null, SAFE).body || {};
    if (!b.results) throw new Error("GET /api/ni/entities/problems returned no results list (VERIFY the request on your release); not reporting that as no problems.");
    for (var i = 0; i < b.results.length; i++) {
      var item = { entity_type: String(b.results[i].entity_type || "ProblemEvent"), entity_id: String(b.results[i].entity_id) };
      if (b.results[i].time !== undefined && b.results[i].time !== null) item.time = b.results[i].time;
      ids.push(item);
    }
    if (!b.cursor || String(b.cursor) === cursor || b.results.length === 0 || (b.total_count !== undefined && b.total_count !== null && ids.length >= Number(b.total_count))) break;
    cursor = String(b.cursor);
  }
  System.log(ids.length + " open problem event(s) in the window");
  // Their details, 100 at a time (the API takes up to 1000).
  for (var at = 0; at < ids.length; at += 100) {
    var f = core.http("POST", ni + "/entities/problems/fetch", auth, { entity_ids: ids.slice(at, at + 100) }, SAFE).body || {};
    if (!f.results) throw new Error("POST /api/ni/entities/problems/fetch returned no results list.");
    for (var r = 0; r < f.results.length; r++) {
      var e = f.results[r].entity || {};
      var sev = String(e.severity || "").toUpperCase();
      if (KEEP.indexOf(sev) < 0) continue;
      var anchors = [];
      var list = e.anchor_entities || [];
      for (var a = 0; a < list.length; a++) anchors.push(list[a].entity_id);
      found.push({ severity: sev, line: sev + "\t" + (e.name || e.problem_type || "?") + "\t" + anchors.join(" ") });
    }
  }
} finally {
  core.logoutVcfNetworks(settings.netHost, auth);
}
found.sort(function (x, y) { return x.severity < y.severity ? -1 : x.severity > y.severity ? 1 : 0; });
var lines = [];
for (var l = 0; l < found.length; l++) { lines.push(found[l].line); System.log(found[l].line); }
problemsTsv = lines.join("\n") + (lines.length ? "\n" : "");
problemCount = lines.length;
System.log(lines.length + " at " + FLOOR + " or above");
summary = core.audit(null, { open: ids.length, reported: lines.length, severity: FLOOR });
core.notify(settings.webhook, summary);
if (lines.length > 0 && String(settings.failWhenFound) !== "false") throw new Error(lines.length + " open problem(s) at " + FLOOR + " or above; see problemsTsv.");`,
      });

      return {
        platform: NETWORKS,
        title: `Networks infrastructure problems — ${severity} and above, last ${hours}h`,
        effect: 'read',
        trigger: { kind: 'schedule', detail: `Daily at 06:45, over the last ${hours} hours`, worstCase: 'once a day' },
        scope: {
          what: `Open problem events in VCF Operations for Networks, severity ${include.join(', ')}.`,
          decidedBy: ['What Networks raises as a problem event, which depends on its data sources.', `The severity floor: ${severity}.`, `The ${hours}-hour window.`],
          ifWrong: 'A problem missed because it is older than the window, or a report so noisy it is ignored. Neither changes anything.',
        },
        guardrails: [
          { rule: 'Reads only, and exits 1 only when something at or above the floor is open', because: 'A scheduler alerts on the exit code; one that always fails trains people to ignore it.' },
          { rule: 'The login uses a mode-600 password file, not a token in the crontab, and the token reaches curl from a private header file', because: 'Networks tokens expire, and a password in a crontab or a token on a command line is readable by other users of the host.' },
          { rule: 'Follows the search cursor to the last page, fetches details 100 at a time through files, and stops (exit 2) when a response has no results list', because: 'One unpaged page hides everything after the first thousand, a long id list on the command line fails at 128 KB, and a response in an unexpected shape would otherwise read as "no problems".' },
        ],
        dryRun: [`It only reads. Run the workflow Networks problems ${base} (or the script) by hand once and compare with the 9.1 health dashboards in the interface.`],
        undo: ['Nothing to undo.'],
        told: [`Whoever reads ${base}.tsv (the workflow's problemsTsv output), and whatever alerts on the exit code or the failed run; the webhook in the workflow settings, if set.`],
        requires: ['A read-only Networks account.', 'jq and curl for the script.', NET_PACKAGE_REQUIRES],
        files: {
          ...pkg.files,
          [`scripts/${base}.sh`]: script,
          ...(schedule ? { 'crontab.txt': `# Daily at 06:45 with the fallback script. The password file is mode 600 and owned by the account that runs this.\n# With the Orchestrator package, schedule the workflow in Orchestrator instead and leave this out.\n45 6 * * * cd /opt/archtoolkit/${base} && ${networksScheduledEnv('svc-vcfnet-readonly')} ./scripts/${base}.sh >> /var/log/${base}.log 2>&1\n` } : {}),
          'IMPORT.md': importMd({
            title: 'the Networks infrastructure problems report',
            intro: ['An Orchestrator package that reads the open problem events from VCF Operations for Networks, and the same report as a script for cron.'],
            steps: [
              ...packageSteps(pkg, 'reports open problems'),
              {
                heading: 'What the workflow calls',
                files: [],
                how: [`POST /api/ni/auth/token; GET /api/ni/entities/problems?size=1000&event_status=open&start_time=…&end_time=… (following cursor); POST /api/ni/entities/problems/fetch 100 at a time; DELETE /api/ni/auth/token. Severity is filtered in the workflow (${include.join(', ')}). Schedule it in Orchestrator for a daily report: a failed run is the alert.`],
                verify: ['the severity values and the name and anchor_entities fields of a fetched problem event: the 9.x API reference documents entity.severity only.'],
              },
              { heading: 'Or: the script, from cron', files: [`scripts/${base}.sh`, ...(schedule ? ['crontab.txt'] : [])], how: [`./scripts/${base}.sh writes ${base}.tsv and exits 1 when anything at or above ${severity} is open${schedule ? '; crontab.txt runs it daily' : ''}.`] },
            ],
          }),
        },
        notes: [
          'CONFIRMED in the 9.1 release notes: infrastructure health dashboards that capture critical issues around appliances and capabilities, and NSX health metrics for appliances, edges and host networking.',
          'Changed for 9.1: the problems are listed with GET /api/ni/entities/problems (size, cursor, start_time, end_time, event_status=open) and fetched with POST /api/ni/entities/problems/fetch, both in the VCF Operations for Networks 9.1 API reference (developer.broadcom.com, Entities), instead of POST /search with entity_type ProblemEvent. VERIFY: the severity values and the name and anchor_entities fields of a fetched event; the reference documents entity.severity only.',
        ],
        findings,
      };
    },
  }),
];
