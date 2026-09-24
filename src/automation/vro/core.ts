/**
 * The ArchToolKit core library for Orchestrator: package com.archtoolkit.core.
 *
 * Every automation package calls these actions instead of carrying its own
 * copy of login, HTTP, paging, guardrails and audit. The package is imported
 * once; after that each automation package is only its own workflow, its own
 * actions, its settings and its payloads.
 *
 * The scripts target the Orchestrator shipped with VCF 9.1 (VCF Automation 9.1
 * and VCF Operations Orchestrator 9.1). They are written as ES5 — var and
 * function, no let/const, arrow functions, template literals or classes —
 * because that is what every Orchestrator JavaScript runtime since 7.x runs;
 * later releases accept more, and ES5 costs nothing. The emulator's syntax
 * check (src/testing/vro-emulator.ts) enforces it.
 *
 * Secrets come from SecureString attributes of a configuration element, read
 * by settings(). Nothing here logs a header, a request body or a settings
 * object, and http() puts neither in an error; options.redact scrubs a secret
 * the far end echoes back.
 *
 * Calls are System.getModule("com.archtoolkit.core").<action>(...), which is
 * how Orchestrator runs an action from a script: in the same JavaScript
 * context, so objects and functions pass in and out unchanged (the guard's
 * act() takes a function).
 */

import { stableId } from '../vcfa-import.ts';
import type { VroParamSpec } from '../../kit/vro-package.ts';

export const CORE_MODULE = 'com.archtoolkit.core';
export const CORE_PACKAGE = 'com.archtoolkit.core';
export const CORE_VERSION = '1.0.0';
/** Where the core package's text files go in an automation's output. */
export const CORE_PACKAGE_DIR = `import/${CORE_PACKAGE}.package`;
/** The line an automation script starts with to reach the core library. */
export const CORE_REF = `var core = System.getModule("${CORE_MODULE}");`;

/** One Orchestrator action: its script is the body of a function of its params. */
export interface VroActionDef {
  readonly name: string;
  readonly description: string;
  readonly resultType: string;
  readonly params: readonly VroParamSpec[];
  readonly script: string;
}

const p = (name: string, type: string, description: string): VroParamSpec => ({ name, type, description });

// ---------------------------------------------------------------------------
// The actions. Each script is an action body: its params are in scope, and it
// ends with return.

const settings: VroActionDef = {
  name: 'settings',
  description: 'Read one configuration element into a plain object, { attribute: value }. SecureString attributes come back as their value, and their values are also listed in _secrets, to pass to http() as options.redact. Never log the result.',
  resultType: 'Any',
  params: [p('categoryPath', 'string', 'Configuration folder, e.g. ArchToolKit/Tags'), p('name', 'string', 'Configuration element name')],
  script: String.raw`if (!categoryPath || !name) throw new Error("settings: categoryPath and name are required");
var category = Server.getConfigurationElementCategoryWithPath(String(categoryPath));
if (!category) throw new Error("No configuration folder '" + categoryPath + "'. Import the package again, or look under Assets > Configurations.");
var elements = category.allConfigurationElements || [];
var element = null;
for (var i = 0; i < elements.length; i++) {
  if (String(elements[i].name) === String(name)) { element = elements[i]; break; }
}
if (!element) throw new Error("No configuration element '" + name + "' in '" + categoryPath + "'.");
var out = {};
var secrets = [];
var attributes = element.attributes || [];
for (var j = 0; j < attributes.length; j++) {
  out[String(attributes[j].name)] = attributes[j].value;
  if (String(attributes[j].type) === "SecureString" && attributes[j].value) secrets.push(String(attributes[j].value));
}
out._secrets = secrets;
return out;`,
};

const resource: VroActionDef = {
  name: 'resource',
  description: 'The content of a resource element, as text: the payloads and reference data an automation carries.',
  resultType: 'string',
  params: [p('categoryPath', 'string', 'Resource folder, e.g. ArchToolKit/Tags'), p('name', 'string', 'Resource element name, e.g. tag-standard.json')],
  script: String.raw`var category = Server.getResourceElementCategoryWithPath(String(categoryPath));
if (!category) throw new Error("No resource folder '" + categoryPath + "'. Import the package again, or look under Assets > Resources.");
var list = category.allResourceElements || [];
for (var i = 0; i < list.length; i++) {
  if (String(list[i].name) === String(name)) {
    var mime = list[i].getContentAsMimeAttachment();
    return String(mime.content);
  }
}
throw new Error("No resource element '" + name + "' in '" + categoryPath + "'.");`,
};

const base64: VroActionDef = {
  name: 'base64',
  description: 'Base64 of the UTF-8 bytes of a string (for a Basic authorization header).',
  resultType: 'string',
  params: [p('text', 'string', 'Text to encode')],
  script: String.raw`var utf8 = unescape(encodeURIComponent(String(text)));
var chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
var out = "";
for (var i = 0; i < utf8.length; i += 3) {
  var b0 = utf8.charCodeAt(i);
  var b1 = i + 1 < utf8.length ? utf8.charCodeAt(i + 1) : 0;
  var b2 = i + 2 < utf8.length ? utf8.charCodeAt(i + 2) : 0;
  var n = (b0 << 16) | (b1 << 8) | b2;
  out += chars.charAt((n >> 18) & 63) + chars.charAt((n >> 12) & 63);
  out += i + 1 < utf8.length ? chars.charAt((n >> 6) & 63) : "=";
  out += i + 2 < utf8.length ? chars.charAt(n & 63) : "=";
}
return out;`,
};

const http: VroActionDef = {
  name: 'http',
  description:
    'One REST call through a transient REST host. Returns { statusCode, body (parsed JSON, or the text), text }. Throws on a status outside 200-299 (and options.allow) with the method, the URL without its query, the status and the start of the response; never a header or the request body, and the value of every header sent (and of its last word, the token of "Bearer x") is scrubbed from the error. options: contentType, accept, allow (array of statuses to return rather than throw), redact (more strings to scrub, from the URL in the error too, e.g. settings._secrets or a webhook path), timeout (seconds, default 60). The endpoint certificate must be trusted in Orchestrator (SSL Trust Manager).',
  resultType: 'Any',
  params: [
    p('method', 'string', 'GET, POST, PUT, PATCH or DELETE'),
    p('url', 'string', 'Absolute URL, https://host[:port]/path?query'),
    p('headers', 'Any', 'Object of header name to value, or null'),
    p('body', 'Any', 'Object (sent as JSON), string (sent as is) or null'),
    p('options', 'Any', 'Object or null; see the description'),
  ],
  script: String.raw`var opts = options || {};
var secrets = [];
var extra = opts.redact || [];
for (var s = 0; s < extra.length; s++) if (extra[s]) secrets.push(String(extra[s]));
if (headers) {
  for (var h in headers) {
    if (!headers.hasOwnProperty(h) || !headers[h]) continue;
    var value = String(headers[h]);
    secrets.push(value);
    var words = value.split(" ");
    if (words.length > 1 && words[words.length - 1].length >= 8) secrets.push(words[words.length - 1]);
  }
}
function scrub(text) {
  var out = String(text);
  for (var i = 0; i < secrets.length; i++) out = out.split(secrets[i]).join("****");
  return out;
}
var match = /^(https?:\/\/[^\/?#]+)([^#]*)$/.exec(String(url));
if (!match) throw new Error("http: not an absolute URL: " + scrub(String(url).split("?")[0]));
var base = match[1];
var path = match[2] || "/";
var where = String(method) + " " + base + path.split("?")[0];
for (var r = 0; r < extra.length; r++) if (extra[r] && String(extra[r]) !== "/") where = where.split(String(extra[r])).join("****");
var content = null;
if (body !== null && body !== undefined) content = typeof body === "string" ? body : JSON.stringify(body);
var host = RESTHostManager.createHost("archtoolkit");
host.url = base;
host.connectionTimeout = opts.timeout || 60;
host.operationTimeout = opts.timeout || 60;
var transientHost = RESTHostManager.createTransientHostFrom(host);
var request = transientHost.createRequest(String(method), path, content);
request.contentType = opts.contentType || "application/json";
request.setHeader("Accept", opts.accept || "application/json");
if (headers) {
  for (var key in headers) {
    if (headers.hasOwnProperty(key)) request.setHeader(key, String(headers[key]));
  }
}
var response;
try {
  response = request.execute();
} catch (e) {
  throw new Error(where + " failed: " + scrub(String(e)));
}
var status = Number(response.statusCode);
var raw = response.contentAsString;
var text = raw === null || raw === undefined ? "" : String(raw);
var allowed = opts.allow || [];
if ((status < 200 || status > 299) && allowed.indexOf(status) < 0) {
  throw new Error(where + " returned HTTP " + status + (text ? ": " + scrub(text.substring(0, 300)) : ""));
}
var parsed = text;
if (/^\s*[\[{"]/.test(text)) {
  try { parsed = JSON.parse(text); } catch (e2) { parsed = text; }
}
return { statusCode: status, body: parsed, text: text };`,
};

const loginVcfOps: VroActionDef = {
  name: 'loginVcfOps',
  description: 'VCF Operations: POST /suite-api/api/auth/token/acquire. Returns the header { Authorization: "OpsToken <token>" }.',
  resultType: 'Any',
  params: [p('host', 'string', 'VCF Operations host[:port]'), p('username', 'string', 'Account'), p('password', 'string', 'From a SecureString attribute'), p('authSource', 'string', 'Authentication source, empty for local')],
  script: String.raw`var core = System.getModule("com.archtoolkit.core");
var credentials = { username: String(username), password: String(password) };
if (authSource) credentials.authSource = String(authSource);
var r = core.http("POST", "https://" + host + "/suite-api/api/auth/token/acquire", null, credentials, { redact: [password] });
if (!r.body || !r.body.token) throw new Error("VCF Operations at " + host + " returned no token.");
return { "Authorization": "OpsToken " + r.body.token };`,
};

const logoutVcfOps: VroActionDef = {
  name: 'logoutVcfOps',
  description: 'VCF Operations: POST /suite-api/api/auth/token/release. Never throws; a failed release is a warning.',
  resultType: 'boolean',
  params: [p('host', 'string', 'VCF Operations host[:port]'), p('headers', 'Any', 'What loginVcfOps returned')],
  script: String.raw`try {
  System.getModule("com.archtoolkit.core").http("POST", "https://" + host + "/suite-api/api/auth/token/release", headers, null, {});
  return true;
} catch (e) {
  System.warn("Could not release the VCF Operations session (" + e + ")");
  return false;
}`,
};

const loginVcfFleet: VroActionDef = {
  name: 'loginVcfFleet',
  description: 'VCF 9.1 identity broker: exchange an API token (issued to an API client in VCF Operations) for a bearer token, POST https://<idb>/acs/t/CUSTOMER/token. Returns { Authorization: "Bearer <access token>" }.',
  resultType: 'Any',
  params: [p('idbHost', 'string', 'VCF Identity Broker host'), p('apiToken', 'string', 'From a SecureString attribute')],
  script: String.raw`var core = System.getModule("com.archtoolkit.core");
var form = ["grant_type=" + encodeURIComponent("urn:custom:vcf:params:oauth:grant-type:api-token"), "api_token" + "=" + encodeURIComponent(String(apiToken))].join("&");
var r = core.http("POST", "https://" + idbHost + "/acs/t/CUSTOMER/token", null, form, { contentType: "application/x-www-form-urlencoded", redact: [apiToken] });
if (!r.body || !r.body.access_token) throw new Error("The identity broker at " + idbHost + " returned no access token.");
return { "Authorization": "Bearer " + r.body.access_token };`,
};

const loginSddcManager: VroActionDef = {
  name: 'loginSddcManager',
  description: 'SDDC Manager: POST /v1/tokens. Returns { Authorization: "Bearer <accessToken>" }.',
  resultType: 'Any',
  params: [p('host', 'string', 'SDDC Manager host'), p('username', 'string', 'Account'), p('password', 'string', 'From a SecureString attribute')],
  script: String.raw`var core = System.getModule("com.archtoolkit.core");
var r = core.http("POST", "https://" + host + "/v1/tokens", null, { username: String(username), password: String(password) }, { redact: [password] });
if (!r.body || !r.body.accessToken) throw new Error("SDDC Manager at " + host + " returned no access token.");
return { "Authorization": "Bearer " + r.body.accessToken };`,
};

const loginVcenter: VroActionDef = {
  name: 'loginVcenter',
  description: 'vCenter with a user and password: POST /api/session with Basic authorization. Returns { "vmware-api-session-id": <id> }.',
  resultType: 'Any',
  params: [p('host', 'string', 'vCenter host'), p('username', 'string', 'Account, user@domain'), p('password', 'string', 'From a SecureString attribute')],
  script: String.raw`var core = System.getModule("com.archtoolkit.core");
var basic = { "Authorization": "Basic " + core.base64(String(username) + ":" + String(password)) };
var r = core.http("POST", "https://" + host + "/api/session", basic, null, { redact: [password] });
if (typeof r.body !== "string" || !r.body) throw new Error("vCenter " + host + " returned no session id.");
return { "vmware-api-session-id": r.body };`,
};

const loginVcenterToken: VroActionDef = {
  name: 'loginVcenterToken',
  description:
    'vCenter in VCF 9.1 with an API token and no password: identity broker access token, exchanged at /api/vcenter/authentication/token for a SAML token, which is gzipped, base64-encoded and presented in a SIGN authorization header to POST /api/session. VERIFY on your release: the exchange and the SIGN header follow davidwzhang.com, "VCF 9.1 API Access (4)". Returns { "vmware-api-session-id": <id> }.',
  resultType: 'Any',
  params: [p('host', 'string', 'vCenter host'), p('idbHost', 'string', 'VCF Identity Broker host'), p('apiToken', 'string', 'From a SecureString attribute')],
  script: String.raw`var core = System.getModule("com.archtoolkit.core");
var bearer = core.loginVcfFleet(idbHost, apiToken);
var access = String(bearer.Authorization).substring("Bearer ".length);
var form = [
  "grant_type=" + encodeURIComponent("urn:ietf:params:oauth:grant-type:token-exchange"),
  "requested_token_type=" + encodeURIComponent("urn:ietf:params:oauth:token-type:saml2"),
  "subject_token_type=" + encodeURIComponent("urn:ietf:params:oauth:token-type:access_token"),
  "subject_token" + "=" + encodeURIComponent(access)
].join("&");
var r = core.http("POST", "https://" + host + "/api/vcenter/authentication/token", bearer, form, { contentType: "application/x-www-form-urlencoded", redact: [apiToken, access] });
var saml = r.body && r.body.access_token;
if (!saml) throw new Error("vCenter " + host + " did not exchange the access token for a SAML token.");
var ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function decode(text) {
  var clean = String(text).replace(/_/g, "/").replace(/-/g, "+").replace(/[^A-Za-z0-9+\/]/g, "");
  var bytes = [];
  var bits = 0;
  var value = 0;
  for (var i = 0; i < clean.length; i++) {
    value = (value << 6) | ALPHABET.indexOf(clean.charAt(i));
    bits += 6;
    if (bits >= 8) { bits -= 8; bytes.push((value >> bits) & 255); }
  }
  return bytes;
}
function encode(bytes) {
  var out = "";
  for (var i = 0; i < bytes.length; i += 3) {
    var n = (bytes[i] << 16) | ((i + 1 < bytes.length ? bytes[i + 1] : 0) << 8) | (i + 2 < bytes.length ? bytes[i + 2] : 0);
    out += ALPHABET.charAt((n >> 18) & 63) + ALPHABET.charAt((n >> 12) & 63);
    out += i + 1 < bytes.length ? ALPHABET.charAt((n >> 6) & 63) : "=";
    out += i + 2 < bytes.length ? ALPHABET.charAt(n & 63) : "=";
  }
  return out;
}
// gzip with stored (uncompressed) deflate blocks: a valid gzip stream, which is
// all the SIGN header needs, without a compressor in JavaScript.
function gzip(bytes) {
  var table = [];
  for (var n = 0; n < 256; n++) {
    var c = n;
    for (var k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table.push(c >>> 0);
  }
  var crc = 0xffffffff;
  for (var i = 0; i < bytes.length; i++) crc = table[(crc ^ bytes[i]) & 255] ^ (crc >>> 8);
  crc = (crc ^ 0xffffffff) >>> 0;
  var out = [0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 255];
  var at = 0;
  do {
    var len = Math.min(65535, bytes.length - at);
    var last = at + len >= bytes.length ? 1 : 0;
    out.push(last, len & 255, (len >> 8) & 255, ~len & 255, (~len >> 8) & 255);
    for (var j = 0; j < len; j++) out.push(bytes[at + j]);
    at += len;
  } while (at < bytes.length);
  var size = bytes.length;
  out.push(crc & 255, (crc >>> 8) & 255, (crc >>> 16) & 255, (crc >>> 24) & 255);
  out.push(size & 255, (size >>> 8) & 255, (size >>> 16) & 255, (size >>> 24) & 255);
  return out;
}
var signed = encode(gzip(decode(saml)));
var s = core.http("POST", "https://" + host + "/api/session", { "Authorization": "SIGN token=\"" + signed + "\"" }, null, { redact: [apiToken, access, signed] });
if (typeof s.body !== "string" || !s.body) throw new Error("Login to vCenter " + host + " with the API token failed.");
return { "vmware-api-session-id": s.body };`,
};

const logoutVcenter: VroActionDef = {
  name: 'logoutVcenter',
  description: 'vCenter: DELETE /api/session. Never throws; a failed logout is a warning.',
  resultType: 'boolean',
  params: [p('host', 'string', 'vCenter host'), p('headers', 'Any', 'What loginVcenter or loginVcenterToken returned')],
  script: String.raw`try {
  System.getModule("com.archtoolkit.core").http("DELETE", "https://" + host + "/api/session", headers, null, {});
  return true;
} catch (e) {
  System.warn("Could not end the vCenter session on " + host + ": " + e);
  return false;
}`,
};

const loginNsx: VroActionDef = {
  name: 'loginNsx',
  description: 'NSX Manager: the Basic authorization header (NSX takes it on every call). Returns { Authorization: "Basic ..." }.',
  resultType: 'Any',
  params: [p('username', 'string', 'Account'), p('password', 'string', 'From a SecureString attribute')],
  script: String.raw`return { "Authorization": "Basic " + System.getModule("com.archtoolkit.core").base64(String(username) + ":" + String(password)) };`,
};

const exchangeVcfOpsToken: VroActionDef = {
  name: 'exchangeVcfOpsToken',
  description:
    'VCF Operations 9.1: exchange an OpsToken session for a JWT that a VCF management service accepts (KB 450054), POST /suite-api/api/auth/token/exchange {"serviceKeys":[<serviceKey>]}. serviceKey "ops-li" is 9.1 log management. Returns { Authorization: "Bearer <jwt>" }.',
  resultType: 'Any',
  params: [p('host', 'string', 'VCF Operations host[:port]'), p('headers', 'Any', 'What loginVcfOps returned'), p('serviceKey', 'string', 'The service, e.g. ops-li')],
  script: String.raw`var r = System.getModule("com.archtoolkit.core").http("POST", "https://" + host + "/suite-api/api/auth/token/exchange", headers, { serviceKeys: [String(serviceKey)] }, {});
var b = r.body || {};
var jwt = b.token || b.accessToken || b.access_token || (b.tokens && b.tokens.length ? (b.tokens[0].token || b.tokens[0].accessToken) : null);
if (!jwt) throw new Error("The token exchange for " + serviceKey + " at " + host + " returned no token (VERIFY the response shape on your release).");
return { "Authorization": "Bearer " + jwt };`,
};

const loginVcfNetworks: VroActionDef = {
  name: 'loginVcfNetworks',
  description:
    'VCF Operations for Networks: POST /api/ni/auth/token with {username, password, domain:{domain_type, value}} (LOCAL/local for a local account, LDAP and the directory domain otherwise). Returns { Authorization: "NetworkInsight <token>" }.',
  resultType: 'Any',
  params: [
    p('host', 'string', 'VCF Operations for Networks platform host'),
    p('username', 'string', 'Account'),
    p('password', 'string', 'From a SecureString attribute'),
    p('domainType', 'string', 'LOCAL or LDAP; empty = LOCAL'),
    p('domain', 'string', 'Directory domain; empty = local'),
  ],
  script: String.raw`var body = { username: String(username), password: String(password), domain: { domain_type: domainType ? String(domainType) : "LOCAL", value: domain ? String(domain) : "local" } };
var r = System.getModule("com.archtoolkit.core").http("POST", "https://" + host + "/api/ni/auth/token", null, body, { redact: [password] });
if (!r.body || !r.body.token) throw new Error("VCF Operations for Networks at " + host + " returned no token.");
return { "Authorization": "NetworkInsight " + r.body.token };`,
};

const logoutVcfNetworks: VroActionDef = {
  name: 'logoutVcfNetworks',
  description: 'VCF Operations for Networks: DELETE /api/ni/auth/token. Never throws; a failed logout is a warning.',
  resultType: 'boolean',
  params: [p('host', 'string', 'Platform host'), p('headers', 'Any', 'What loginVcfNetworks returned')],
  script: String.raw`try {
  System.getModule("com.archtoolkit.core").http("DELETE", "https://" + host + "/api/ni/auth/token", headers, null, { allow: [404] });
  return true;
} catch (e) {
  System.warn("Could not end the VCF Operations for Networks session (" + e + ")");
  return false;
}`,
};

const loginVcfAutomation: VroActionDef = {
  name: 'loginVcfAutomation',
  description:
    'VCF Automation 9. With org "provider": POST /oauth/provider/token. Otherwise POST /oauth/tenant/<org>/token with the organization API token (grant_type=refresh_token). Returns { Authorization: "Bearer <token>" }. When token rotation is on, the exchange returns a new token and the old one stops working: this warns, and the SecureString has to be replaced.',
  resultType: 'Any',
  params: [p('host', 'string', 'VCF Automation host'), p('token', 'string', 'API or refresh token, from a SecureString attribute'), p('org', 'string', 'Organization name, or "provider"')],
  script: String.raw`var core = System.getModule("com.archtoolkit.core");
var r;
if (!org) throw new Error("Set the VCF Automation organization name (or \"provider\") in the configuration element.");
var path = String(org) === "provider" ? "/oauth/provider/token" : "/oauth/tenant/" + encodeURIComponent(String(org)) + "/token";
var form = "grant_type=refresh_token&" + "refresh_token" + "=" + encodeURIComponent(String(token));
r = core.http("POST", "https://" + host + path, null, form, { contentType: "application/x-www-form-urlencoded", accept: "application/*", redact: [token] });
if (!r.body || !r.body.access_token) throw new Error("The token exchange at " + path + " returned no access token.");
if (r.body.refresh_token && String(r.body.refresh_token) !== String(token)) {
  System.warn("VCF Automation token rotation is on: the API token in the configuration element no longer works. Issue a new one and replace it before the next run.");
}
return { "Authorization": "Bearer " + r.body.access_token };`,
};

const pageAll: VroActionDef = {
  name: 'pageAll',
  description:
    'Every page of a list. fetchPage(pageIndex) returns { items: [...], total: <number or null>, more: <boolean or null> }. Stops at an empty page, at more === false, or when total items are in hand. Throws rather than return a partial or repeated list: when a page fails, when total is not reached, when a page starts with the same item (same id, or same JSON) as the page before, or past maxPages (default 10000).',
  resultType: 'Any',
  params: [p('fetchPage', 'Any', 'function (pageIndex) returning { items, total, more }'), p('maxPages', 'number', 'Refuse to read more pages than this; 0 or empty for 10000')],
  script: String.raw`var limit = maxPages && maxPages > 0 ? maxPages : 10000;
var all = [];
var total = null;
var previousFirst = null;
// A page's first item, by its id when it has one: the same first item on two
// pages in a row is an endpoint ignoring the page parameter, not more items.
function firstOf(list) {
  if (!list.length) return null;
  var head = list[0];
  if (head && typeof head === "object" && head.id !== undefined && head.id !== null) return "id:" + String(head.id);
  return "json:" + JSON.stringify(head);
}
for (var page = 0; page < limit; page++) {
  var result = fetchPage(page) || {};
  var items = result.items || [];
  if (result.total !== null && result.total !== undefined) total = Number(result.total);
  var first = firstOf(items);
  if (first !== null && first === previousFirst) throw new Error("Page " + page + " starts with the same item as page " + (page - 1) + " (after " + all.length + " items): the endpoint is not paging; refusing to act on a repeated list.");
  previousFirst = first;
  for (var i = 0; i < items.length; i++) all.push(items[i]);
  if (items.length === 0 || result.more === false || (total !== null && all.length >= total)) {
    if (total !== null && all.length < total) throw new Error("Paging stopped at " + all.length + " of " + total + " items; refusing to act on a partial list.");
    return all;
  }
}
throw new Error("More than " + limit + " pages; refusing to act on a partial list.");`,
};

const begin: VroActionDef = {
  name: 'begin',
  description:
    'Start a guarded run. Returns the run context { dryRun, cap, count, planned, changes, failed, started }. It is a dry run only when the dryRun input is true or the configuration element dryRun attribute is true; otherwise it acts. cap is the configuration element cap attribute: the most changes one run may make (0 allows none).',
  resultType: 'Any',
  params: [p('settings', 'Any', 'What settings() returned'), p('dryRunInput', 'boolean', 'The workflow dryRun input, or null')],
  script: String.raw`var dry = dryRunInput === true || String(dryRunInput) === "true" || !!(settings && (settings.dryRun === true || String(settings.dryRun) === "true"));
var cap = settings && settings.cap !== null && settings.cap !== undefined && settings.cap !== "" ? Number(settings.cap) : 0;
if (!(cap >= 0)) cap = 0;
var ctx = { dryRun: dry, cap: cap, count: 0, planned: [], changes: [], failed: null, started: new Date().toISOString() };
System.log(dry ? "DRY RUN: nothing will be changed." : "LIVE RUN: at most " + cap + " change(s).");
return ctx;`,
};

const act: VroActionDef = {
  name: 'act',
  description:
    'One change, guarded. In a dry run it logs "DRY RUN: would <description>" and does not call fn. Otherwise it refuses once the cap would be exceeded, calls fn, and records the change for the audit. The first failure stops the run: the error names what failed and how many changes were made before it, and every later act() refuses.',
  resultType: 'Any',
  params: [p('ctx', 'Any', 'What begin() returned'), p('description', 'string', 'What the change is, e.g. create symptom "x"'), p('fn', 'Any', 'function () making the change; its result is returned')],
  script: String.raw`if (ctx.failed) throw new Error("Stopped earlier (" + ctx.failed + "); refusing to " + description + ".");
if (ctx.dryRun) {
  ctx.planned.push(String(description));
  System.log("DRY RUN: would " + description);
  if (ctx.cap >= 0 && ctx.planned.length === ctx.cap + 1) System.warn("A live run would stop here: this is change " + ctx.planned.length + " and the cap is " + ctx.cap + ".");
  return null;
}
if (ctx.count + 1 > ctx.cap) {
  ctx.failed = "cap of " + ctx.cap + " reached";
  throw new Error("Cap reached: " + ctx.count + " change(s) made, the cap is " + ctx.cap + "; stopping before: " + description + ".");
}
var result;
try {
  result = fn();
} catch (e) {
  ctx.failed = String(description);
  System.error("FAILED: " + description + ": " + e);
  throw new Error("Stopped after " + ctx.count + " change(s): " + description + " failed: " + (e && e.message ? e.message : e));
}
ctx.count++;
ctx.changes.push({ description: String(description), at: new Date().toISOString() });
System.log("DONE: " + description);
return result;`,
};

const audit: VroActionDef = {
  name: 'audit',
  description: 'The record of a run: logs one AUDIT line per change (or planned change) and returns the whole record as JSON, for a workflow output, a webhook or a log collector.',
  resultType: 'string',
  params: [p('ctx', 'Any', 'What begin() returned, or null for a read-only run'), p('summary', 'Any', 'Object with whatever the automation reports: counts, ids, a verdict')],
  script: String.raw`var c = ctx || { dryRun: false, cap: 0, count: 0, planned: [], changes: [], failed: null, started: null };
var record = {
  source: "archtoolkit",
  workflow: typeof workflow !== "undefined" && workflow && workflow.rootWorkflow ? String(workflow.rootWorkflow.name) : null,
  started: c.started,
  finished: new Date().toISOString(),
  dryRun: c.dryRun,
  cap: c.cap,
  changes: c.changes,
  planned: c.planned,
  failed: c.failed,
  summary: summary || {}
};
for (var i = 0; i < c.changes.length; i++) System.log("AUDIT: changed: " + c.changes[i].description);
for (var j = 0; j < c.planned.length; j++) System.log("AUDIT: would change: " + c.planned[j]);
System.log("AUDIT: " + (c.dryRun ? "dry run, " + c.planned.length + " change(s) planned" : c.count + " change(s) made") + (c.failed ? ", stopped: " + c.failed : "") + ".");
return JSON.stringify(record);`,
};

const notify: VroActionDef = {
  name: 'notify',
  description:
    'POST a JSON payload to a webhook. Returns false and warns (never throws) when the URL is empty or the post fails: a report is not lost because its notification was. A Slack, Teams or Google Chat webhook carries its secret in the path, so the whole URL, its path and its query are redacted and a failure names only the host. Keep the URL in a SecureString attribute.',
  resultType: 'boolean',
  params: [p('webhookUrl', 'string', 'Webhook URL, or empty for none'), p('payload', 'Any', 'Object or JSON string')],
  script: String.raw`if (!webhookUrl) return false;
var url = String(webhookUrl);
var parts = /^(https?:\/\/[^\/?#]+)([^#]*)/.exec(url);
var host = parts ? parts[1] : "the webhook";
var path = parts ? parts[2] : "";
var hidden = [url, path, path.split("?")[0], path.split("?")[1] || ""];
try {
  var body = typeof payload === "string" ? payload : JSON.stringify(payload);
  System.getModule("com.archtoolkit.core").http("POST", url, null, body, { redact: hidden });
  return true;
} catch (e) {
  var reason = String(e && e.message ? e.message : e);
  for (var i = 0; i < hidden.length; i++) if (hidden[i] && hidden[i] !== "/") reason = reason.split(hidden[i]).join("****");
  System.warn("Webhook post to " + host + " failed: " + reason);
  return false;
}`,
};

export const CORE_ACTIONS: readonly VroActionDef[] = [
  settings,
  resource,
  base64,
  http,
  loginVcfOps,
  logoutVcfOps,
  loginVcfFleet,
  loginSddcManager,
  loginVcenter,
  loginVcenterToken,
  logoutVcenter,
  loginNsx,
  exchangeVcfOpsToken,
  loginVcfNetworks,
  logoutVcfNetworks,
  loginVcfAutomation,
  pageAll,
  begin,
  act,
  audit,
  notify,
];

// ---------------------------------------------------------------------------
// Files

/** The text files of one action in the package layout readPackageSpec reads. */
export function actionFiles(module: string, action: VroActionDef): Record<string, string> {
  return {
    [`actions/${module}/${action.name}.js`]: action.script,
    [`actions/${module}/${action.name}.json`]: `${JSON.stringify(
      { id: stableId(`vro-action:${module}/${action.name}`), resultType: action.resultType, params: action.params, description: action.description },
      null,
      2,
    )}\n`,
  };
}

/** The core package's text files, under import/com.archtoolkit.core.package/. */
export function corePackageFiles(): Record<string, string> {
  const inner: Record<string, string> = {
    'package.json': `${JSON.stringify(
      {
        name: CORE_PACKAGE,
        description: 'ArchToolKit core library: settings, REST calls, logins, paging, guardrails and audit, shared by every ArchToolKit automation package. Import it once, before them.',
        version: CORE_VERSION,
      },
      null,
      2,
    )}\n`,
  };
  for (const action of CORE_ACTIONS) Object.assign(inner, actionFiles(CORE_MODULE, action));
  return Object.fromEntries(Object.entries(inner).map(([path, body]) => [`${CORE_PACKAGE_DIR}/${path}`, body]));
}
