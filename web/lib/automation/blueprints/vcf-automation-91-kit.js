/**
 * What the VCF Automation 9.1 helper modules share with vcf-automation-91.ts.
 *
 * The blueprints in vcf-automation-91-govern.ts and vcf-automation-91-network.ts
 * are built by functions that take this kit, so they reuse the shell, kubectl,
 * Terraform and Orchestrator building blocks of vcf-automation-91.ts without
 * importing that file (which includes their blueprints in the array it
 * exports). The kit is filled in once, at the end of vcf-automation-91.ts.
 *
 * Also here: the pieces only the new blueprints need — NSX Policy API calls
 * with a password read from a mode-600 file, a VCF Automation /policy/api apply
 * that finds the policy type by name, and the Orchestrator workflows for both.
 */

                                                                   
                                                              

                                                

/** A Kubernetes object the workflow creates: the object and its resource (plural) name. */
                                   
                          
                                                                                                                                                                                                                                                                                            
 

                               
                        
                               
                                                     
 

                            
                                      
                       
                            
                            
                        
                         
                               
                               
                                             
                                   
                                                    
                               
                                  
                                              
                                                             
                                                         
                                                
                                                                       
                                            
                                                             
                                       
                                            
                                                                                                                                                               
                                                                                                                                              
                                                                                
                                                               
                                                                                                                   
                                                                                                                                                             
                                                                                                                                                                                                                                     
                                                                 
                                                                   
 

// ---------------------------------------------------------------------------
// Small parsers the new blueprints share

/** Rows of a " | " table: trimmed cells, blank lines and # comments skipped. */
export function rowsOf(text        )                                      {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
    .map((line) => ({ cells: line.split('|').map((cell) => cell.trim()), line }));
}

/** label=value pairs, comma separated, as a matchLabels map. */
export function labelsOf(text        )                         {
  const out                         = {};
  for (const part of text.split(',')) {
    const [k = '', v = ''] = part.split('=');
    if (k.trim()) out[k.trim()] = v.trim();
  }
  return out;
}

/** A port, or a range "8000-8080". */
export function portOf(text        )                                                 {
  const m = /^(\d{1,5})(?:-(\d{1,5}))?$/.exec(text.trim());
  if (!m) return undefined;
  const port = Number(m[1]);
  const end = m[2] === undefined ? undefined : Number(m[2]);
  if (port < 1 || port > 65535 || (end !== undefined && (end < port || end > 65535))) return undefined;
  return end === undefined ? { port } : { port, endPort: end };
}

// ---------------------------------------------------------------------------
// NSX Policy API from bash: the password from a mode-600 file, never on argv

/**
 * An NSX Policy API script. Reads NSX_HOST, NSX_USER and NSX_PASSWORD_FILE;
 * user:password reaches curl as a config on a file descriptor. ensure PATH FILE
 * LABEL creates (PATCH) only when nothing is at PATH, so an object someone
 * already maintains is left as it is. Applies when run; --dry-run reads only.
 */
export function nsxScript(opts                                                            )         {
  return [
    '#!/usr/bin/env bash',
    `# ${opts.purpose}`,
    '#',
    '# Applies when run. With --dry-run this only reads and prints what it would send.',
    '# NSX Policy API, as an NSX account with the rights for these objects (Enterprise Admin,',
    '# or Network Admin / Security Admin for the object types involved).',
    'set -euo pipefail',
    'cd "$(dirname "$0")/.."',
    '',
    ': "${NSX_HOST:?set NSX_HOST to the NSX Manager (cluster VIP) of the region}"',
    ': "${NSX_USER:?set NSX_USER to the NSX account}"',
    ': "${NSX_PASSWORD_FILE:?set NSX_PASSWORD_FILE to a mode-600 file holding that account password}"',
    'command -v jq >/dev/null || { echo "jq is required" >&2; exit 2; }',
    'PERM=$(stat -c %a "$NSX_PASSWORD_FILE" 2>/dev/null || stat -f %Lp "$NSX_PASSWORD_FILE")',
    '[[ "$PERM" == 600 || "$PERM" == 400 ]] || { echo "$NSX_PASSWORD_FILE is mode $PERM; make it 600" >&2; exit 2; }',
    '# user:password goes to curl as a config on a file descriptor, never as an argument.',
    "nsx_cfg() { jq -rn --arg u \"$NSX_USER\" --rawfile p \"$NSX_PASSWORD_FILE\" '\"user = \\(($u + \":\" + ($p | rtrimstr(\"\\n\"))) | tojson)\"'; }",
    'API="https://${NSX_HOST}/policy/api/v1"',
    'nsx_get() { curl -sS -f -K <(nsx_cfg) "${API}$1" -H "Accept: application/json"; }',
    'nsx_code() { curl -sS -o /dev/null -w "%{http_code}" -K <(nsx_cfg) "${API}$1" -H "Accept: application/json" || true; }',
    'DRY_RUN=0',
    '[[ " $* " == *" --dry-run "* ]] && DRY_RUN=1',
    'ensure() {  # ensure PATH FILE LABEL: PATCH only when nothing is at PATH yet',
    '  local path="$1" file="$2" what="$3" code',
    '  code=$(nsx_code "$path")',
    '  if [[ "$code" == 200 ]]; then echo "Exists, left as it is: ${what}"; return 0; fi',
    '  [[ "$code" == 404 ]] || { echo "GET ${path} answered HTTP ${code}; stopping (VERIFY the path on this NSX release)" >&2; exit 1; }',
    '  if (( DRY_RUN )); then echo "DRY RUN: would PATCH ${file} to ${path} (${what})"; return 0; fi',
    '  curl -sS -f -K <(nsx_cfg) -X PATCH "${API}${path}" -H "Accept: application/json" -H "Content-Type: application/json" --data-binary @"$file" >/dev/null',
    '  echo "Created: ${what}"',
    '}',
    '',
    ...opts.body,
    '',
    'if (( DRY_RUN )); then echo "Dry run: nothing was changed. Run it without --dry-run to apply."; fi',
    '',
    `# Undo: ${opts.undo}`,
    '',
  ].join('\n');
}

/** An NSX object to create: where it goes, the body, and what to call it in the log. */
                            
                         
                        
                                         
                        
                                                                                                                          
                              
 

/** The ensure lines of nsxScript for a list of objects written as files. */
export function nsxEnsureLines(objects                      )           {
  return objects.flatMap((o) =>
    o.needsPsk
      ? [
          '# The pre-shared key joins the body only here, in a mode-600 temporary file.',
          ': "${IPSEC_PSK_FILE:?set IPSEC_PSK_FILE to a mode-600 file holding the IPsec pre-shared key}"',
          'PERM=$(stat -c %a "$IPSEC_PSK_FILE" 2>/dev/null || stat -f %Lp "$IPSEC_PSK_FILE")',
          '[[ "$PERM" == 600 || "$PERM" == 400 ]] || { echo "$IPSEC_PSK_FILE must be mode 600" >&2; exit 2; }',
          'SESSION_BODY=$(umask 077; mktemp "${TMPDIR:-/tmp}/ipsec.XXXXXX")',
          "trap 'rm -f \"$SESSION_BODY\"' EXIT",
          `jq --rawfile k "$IPSEC_PSK_FILE" '.psk = ($k | rtrimstr("\\n"))' ${JSON.stringify(o.file)} > "$SESSION_BODY"`,
          `ensure ${JSON.stringify(o.path)} "$SESSION_BODY" ${JSON.stringify(o.label)}`,
        ]
      : [`ensure ${JSON.stringify(o.path)} ${JSON.stringify(o.file)} ${JSON.stringify(o.label)}`],
  );
}

// ---------------------------------------------------------------------------
// vCenter from bash: POST /api/session with the password from a mode-600 file

/** VCENTER_HOST must be set before these lines. Defines vc METHOD PATH [curl args]. */
export function vcenterAuthLines()           {
  return [
    '# vCenter session: VCENTER_SESSION if given, otherwise log in with VCENTER_USER and the',
    '# password in VCENTER_PASSWORD_FILE (mode 600), handed to curl as a config on stdin.',
    'if [[ -z "${VCENTER_SESSION:-}" ]]; then',
    '  : "${VCENTER_USER:?set VCENTER_USER and VCENTER_PASSWORD_FILE, or VCENTER_SESSION}"',
    '  : "${VCENTER_PASSWORD_FILE:?set VCENTER_PASSWORD_FILE to a mode-600 file}"',
    '  PERM=$(stat -c %a "$VCENTER_PASSWORD_FILE" 2>/dev/null || stat -f %Lp "$VCENTER_PASSWORD_FILE")',
    '  [[ "$PERM" == 600 || "$PERM" == 400 ]] || { echo "$VCENTER_PASSWORD_FILE must be mode 600" >&2; exit 2; }',
    String.raw`  VCENTER_SESSION=$(jq -rn --arg u "$VCENTER_USER" --rawfile p "$VCENTER_PASSWORD_FILE" '"user = \(($u + ":" + ($p | rtrimstr("\n"))) | tojson)"' ` + '\\',
    String.raw`    | curl -sS -f -K - -X POST "https://${'$'}{VCENTER_HOST}/api/session" | jq -r 'if type == "string" then . else empty end')`,
    'fi',
    '[[ -n "$VCENTER_SESSION" ]] || { echo "No vCenter session." >&2; exit 1; }',
    '# The session id reaches curl from a private header file, never as an argument.',
    'VC_HDR=$(umask 077; mktemp "${TMPDIR:-/tmp}/vc.XXXXXX")',
    "trap 'rm -f \"$VC_HDR\"' EXIT",
    "printf 'vmware-api-session-id: %s\\n' \"$VCENTER_SESSION\" > \"$VC_HDR\"",
    'vc() {  # vc METHOD PATH [curl args]',
    '  local method="$1" path="$2"; shift 2',
    '  curl -sS -f -X "$method" "https://${VCENTER_HOST}${path}" -H "@${VC_HDR}" -H "Accept: application/json" -H "Content-Type: application/json" "$@"',
    '}',
  ];
}

/** tag_id "Category:Tag": the vCenter tag id, or stop. Needs vc from vcenterAuthLines. */
export function vcenterTagLines()           {
  return [
    'tag_id() {',
    '  local cat="${1%%:*}" tag="${1#*:}" cid="" c t',
    "  for c in $(vc GET /api/cis/tagging/category | jq -r '.[]'); do",
    '    [[ "$(vc GET "/api/cis/tagging/category/$c" | jq -r .name)" == "$cat" ]] && { cid="$c"; break; }',
    '  done',
    '  [[ -n "$cid" ]] || { echo "No tag category ${cat} in vCenter" >&2; exit 1; }',
    "  for t in $(vc POST '/api/cis/tagging/tag?action=list-tags-for-category' --data \"$(jq -cn --arg c \"$cid\" '{category_id: $c}')\" | jq -r '.[]'); do",
    '    [[ "$(vc GET "/api/cis/tagging/tag/$t" | jq -r .name)" == "$tag" ]] && { echo "$t"; return 0; }',
    '  done',
    '  echo "No tag ${tag} in category ${cat}" >&2; exit 1',
    '}',
  ];
}

/** The Orchestrator workflow of an NSX apply: GET each path, PATCH only what is not there. */
export function nsxWorkflow(resource        )         {
  return String.raw`var SAFE = { redact: settings._secrets };
if (!settings.nsxHost || !settings.nsxUser || !settings.nsxPassword) throw new Error("Set nsxHost, nsxUser and nsxPassword in the configuration element " + SETTINGS_NAME + ".");
var items = JSON.parse(core.resource(RESOURCE_PATH, ${JSON.stringify(resource)}));
var ctx = core.begin(settings, dryRun);
var auth = core.loginNsx(String(settings.nsxUser), settings.nsxPassword);
var api = "https://" + settings.nsxHost + "/policy/api/v1";
var created = [];
for (var i = 0; i < items.length; i++) {
  var it = items[i];
  var r = core.http("GET", api + it.path, auth, null, { allow: [404], redact: SAFE.redact });
  if (r.statusCode !== 404) {
    System.log("Exists, left as it is: " + it.label + " (" + it.path + ")");
    continue;
  }
  if (it.needsPsk) {
    if (!settings.ipsecPsk) throw new Error("Set ipsecPsk in " + SETTINGS_NAME + " before " + it.label + " can be created.");
    it.body.psk = String(settings.ipsecPsk);
  }
  (function (item) {
    core.act(ctx, "create " + item.label + " at " + item.path, function () { return core.http("PATCH", api + item.path, auth, item.body, SAFE).statusCode; });
  })(it);
  if (!ctx.dryRun) created.push(it.label);
}
createdObjects = created.join(", ");
summary = core.audit(ctx, { nsxHost: String(settings.nsxHost), created: created });
core.notify(settings.webhook, summary);`;
}

export function nsxConfig(what        , cap        , kit           )               {
  return {
    name: 'Settings',
    description: `Settings of the ${what} workflow. Fill nsxPassword after import; set dryRun to false only after a dry run.`,
    attributes: [
      { name: 'nsxHost', type: 'string', value: '', description: 'NSX Manager (cluster VIP) of the region' },
      { name: 'nsxUser', type: 'string', value: '', description: 'NSX account with the rights for these objects' },
      { name: 'nsxPassword', type: 'SecureString', description: 'Its password. Stored encrypted, never logged.' },
      ...kit.GUARD_ATTRS(cap),
      kit.WEBHOOK_ATTR,
    ],
  };
}

// ---------------------------------------------------------------------------
// VCF Automation /policy/api: the policy type found by its name

/**
 * The bash body that creates one policy through /policy/api/policies unless a
 * policy of that name and type exists. The type id is read from
 * /policy/api/policyTypes by name (POLICY_TYPE_ID overrides it), because the ids
 * of the 9.1 All Apps policy types are not in Broadcom's API reference.
 */
export function policyApplyLines(opts                                                                  )           {
  return [
    `NAME=${JSON.stringify(opts.name)}`,
    `TYPE_RE=${JSON.stringify(opts.typeName)}`,
    '# The policy type: POLICY_TYPE_ID if set, else the one /policy/api/policyTypes names like TYPE_RE.',
    `TYPE_ID="\${POLICY_TYPE_ID:-}"`,
    'if [[ -z "$TYPE_ID" ]]; then',
    '  TYPES=$(get "/policy/api/policyTypes?size=200" application/json) || TYPES="{}"',
    "  TYPE_ID=$(jq -r --arg re \"$TYPE_RE\" '[(.content // .)[]? | select((.name // \"\") | test($re; \"i\")) | .id][0] // empty' <<<\"$TYPES\")",
    'fi',
    `if [[ -z "$TYPE_ID" ]]; then TYPE_ID=${JSON.stringify(opts.typeId)}; echo "VERIFY: no policy type named like \${TYPE_RE} in /policy/api/policyTypes; trying \${TYPE_ID}. Create one such policy in the interface and read its typeId with GET /policy/api/policies, then set POLICY_TYPE_ID." >&2; fi`,
    'BODY=$(mktemp); trap \'rm -f "$BODY"\' EXIT',
    `jq --arg t "$TYPE_ID" --arg p "\${PROJECT_ID:-}" '.typeId = $t | if $p != "" and (.projectId // "") == "" then .projectId = $p else . end' ${JSON.stringify(opts.file)} > "$BODY"`,
    "ENC=$(jq -rn --arg n \"$NAME\" '$n | @uri')",
    'LIST=$(get "/policy/api/policies?search=${ENC}&size=200" application/json)',
    "SAME=$(jq --arg n \"$NAME\" --arg t \"$TYPE_ID\" '[.content[]? | select(.name == $n and .typeId == $t)] | length' <<<\"$LIST\")",
    'if (( SAME > 0 )); then',
    '  echo "Exists, left as it is: policy ${NAME} (${TYPE_ID}). Change it in the interface, or delete it and run again."',
    'else',
    '  send POST /policy/api/policies "$BODY" application/json',
    'fi',
  ];
}

/** The Orchestrator workflow of a /policy/api apply: type by name, create unless it exists. */
export function policyWorkflow(kit           , resource        )         {
  return [
    kit.LOGIN_JS(null),
    String.raw`var P = JSON.parse(core.resource(RESOURCE_PATH, ${JSON.stringify(resource)}));
var ctx = core.begin(settings, dryRun);
var api = "https://" + settings.vcfaHost;
var auth = core.loginVcfAutomation(String(settings.vcfaHost), settings.vcfaApiToken, ORG);
// The policy type by name: the ids of the 9.1 All Apps policy types are not in the API reference (VERIFY).
var typeId = settings.policyTypeId ? String(settings.policyTypeId) : "";
if (!typeId) {
  var t = core.http("GET", api + "/policy/api/policyTypes?size=200", auth, null, { allow: [404], redact: SAFE.redact });
  var types = t.statusCode === 404 ? [] : ((t.body && (t.body.content || t.body)) || []);
  var re = new RegExp(P.typeName, "i");
  for (var i = 0; i < types.length; i++) if (!typeId && re.test(String(types[i].name || ""))) typeId = String(types[i].id);
  if (!typeId) {
    typeId = P.typeId;
    System.warn("VERIFY: no policy type named like " + P.typeName + " at /policy/api/policyTypes; trying " + typeId + ". Create one such policy in the interface, read its typeId with GET /policy/api/policies and set policyTypeId in " + SETTINGS_NAME + ".");
  }
}
var body = P.body;
body.typeId = typeId;
if (settings.projectId && !body.projectId) body.projectId = String(settings.projectId);
if (P.project && !body.projectId) throw new Error("Set projectId in " + SETTINGS_NAME + " to the id of project " + P.project + ": without it the policy would cover the whole organization.");
var list = core.http("GET", api + "/policy/api/policies?search=" + encodeURIComponent(body.name) + "&size=200", auth, null, SAFE).body || {};
var same = [];
for (var j = 0; j < (list.content || []).length; j++) if (String(list.content[j].name) === String(body.name) && String(list.content[j].typeId) === typeId) same.push(list.content[j]);
var policyId = "";
if (same.length > 0) {
  policyId = String(same[0].id);
  System.log("Exists, left as it is: policy " + body.name + " (" + policyId + "). Change it in the interface, or delete it and run again.");
} else {
  policyId = core.act(ctx, "create " + typeId + " policy \"" + body.name + "\"" + (body.projectId ? " in project " + body.projectId : " for the organization"), function () {
    var r = core.http("POST", api + "/policy/api/policies", auth, body, SAFE);
    return r.body && r.body.id ? String(r.body.id) : "";
  }) || "";
}
createdObjects = policyId;
summary = core.audit(ctx, { policy: body.name, typeId: typeId, id: policyId });
core.notify(settings.webhook, summary);`,
  ].join('\n');
}

export function policyConfig(kit           , what        , org        )               {
  return {
    name: 'Settings',
    description: `Settings of the ${what} workflow. Fill vcfaApiToken (an organization administrator's API token) after import; set dryRun to false only after a dry run.`,
    attributes: [
      kit.VCFA_HOST_ATTR,
      kit.ORG_ATTR(org),
      kit.TOKEN_ATTR('an organization administrator'),
      { name: 'projectId', type: 'string', value: '', description: 'The project id for a project-scoped policy; empty for the whole organization' },
      { name: 'policyTypeId', type: 'string', value: '', description: 'The policy typeId, when /policy/api/policyTypes does not name it (VERIFY: read it from a policy made in the interface)' },
      ...kit.GUARD_ATTRS(1),
      kit.WEBHOOK_ATTR,
    ],
  };
}

export const POLICY_OUTPUTS                      = [
  { name: 'createdObjects', type: 'string', description: 'The id of the policy created or found; empty in a dry run that would create it' },
  { name: 'summary', type: 'string', description: 'The audit record, JSON' },
];
