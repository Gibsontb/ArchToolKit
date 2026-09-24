/**
 * Getting what the VCF Automation blueprints generate *into* VCF Automation.
 *
 * A payload that has to be pasted into a designer by hand is a description of
 * the work, not the work. Every VCF Automation blueprint therefore also emits an
 * `import/` folder of artifacts in the form VCF Automation itself takes, and an
 * IMPORT.md that says, in order, where each one goes: the menu path, or the one
 * command that puts it there.
 *
 * What each format is, and where it was established:
 *
 * Cloud templates ("blueprints" in the API and in 9.x).
 *   One folder per template, the file named blueprint.yaml, with `name` and
 *   `version` at the top — the layout the git integration reads (Broadcom,
 *   "How do I use Git integration in VCF Automation for VM Apps", 9.0, and the
 *   Aria Automation 8.x page of the same name). The same YAML is what the
 *   Upload dialog in a VM Apps organization and "New From Import" in an All Apps
 *   organization take (Broadcom 9.1, "Import a Blueprint into VCF Automation":
 *   Build & Deploy → Content Hub → Blueprint Design → Blueprints → New From
 *   Import, OVA/OVF or YAML). By API: POST /blueprint/api/blueprints
 *   {name, description, projectId, content, requestScopeOrg}, PUT
 *   /blueprint/api/blueprints/{id} to update, POST
 *   /blueprint/api/blueprint-validation to validate, POST
 *   /blueprint/api/blueprints/{id}/versions {version, description, changeLog,
 *   release} (Aria Automation 8.18 API Programming Guide, "Create and Update a
 *   Cloud Template" and "Version and Release a Cloud Template").
 *
 * ABX actions.
 *   POST /abx/api/resources/actions with name, projectId, orgId, runtime,
 *   entrypoint, source, inputs, timeoutSeconds, memoryInMB, actionType —
 *   field names from the ABX API (the VM Apps organization ABX service at
 *   developer.broadcom.com, 9.0–9.1.1; idem-vra's client generated from the same
 *   specification). The UI route is Extensibility → Library → Actions → New →
 *   Import package, taking a zip with the script at its root and the Main
 *   function written as <file>.handler (Broadcom, "Create a ZIP package for
 *   Python runtime extensibility actions"; VMware's AAP ABX deployment guide).
 *   The exported-action bundle (a .abx YAML descriptor beside the script, with
 *   exportVersion "1") is shown only in community examples, so it is emitted
 *   for the git route and marked VERIFY.
 *
 * Orchestrator actions and workflows.
 *   An action is created from JSON — POST /vco/api/actions {name, module,
 *   script, input-parameters [{name, type, description}], output-type} — and
 *   looked up by GET /vco/api/actions/{module}/{name}; PUT /vco/api/actions/{id}
 *   updates it. A workflow is imported as a .workflow file: a zip holding
 *   `workflow-info` (properties) and `workflow-content` (the workflow XML,
 *   UTF-16BE with a big-endian BOM), sent multipart as `file` to POST
 *   /vco/api/workflows?categoryId=…&overwrite=true (Broadcom Orchestrator API
 *   reference, "Import/upload a workflow"; mgovedarov/mcp-vcf-orchestrator,
 *   whose verification matrices record unsigned scaffolded .workflow files
 *   importing and running on vRO 8.18.1 and on VCF Automation 9.1.0, and JSON
 *   action creation on both). No package is built: a .package is signed, and
 *   an unsigned one could not be confirmed to import.
 *
 * JSON payloads (projects, zones, profiles, policies, …) import through the API
 * with the apply.sh each blueprint already has; Kubernetes YAML with kubectl
 * create against the VCF Automation context.
 */

import { slugOf } from './automation.js';

// ---------------------------------------------------------------------------
// Types

/** A cloud template, to be written as import/templates/<slug>/blueprint.yaml. */
                                   
                        
                               
                                                                  
                            
                                                                                                
                        
                                          
                                        
 

                           
                        
                        
                                
 

/** An Orchestrator action, created from JSON. */
                                    
                          
                        
                          
                                       
                              
 

/** An Orchestrator workflow of one scriptable task, built into a .workflow file. */
                                      
                        
                                                                           
                            
                               
                                       
                                        
                                                                        
                          
                             
 

/** An ABX action, created through the ABX API. */
                              
                        
                                        
                          
                               
                                                      
                                  
                               
                                                                                          
                                                            
 

                             
                           
                                    
 

// ---------------------------------------------------------------------------
// Small helpers

/** A string for a YAML scalar: JSON strings are valid YAML double-quoted scalars. */
const y = (text        )         => JSON.stringify(text);

/** Single-quote for bash. */
export function sq(text        )         {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

const json = (value         )         => `${JSON.stringify(value, null, 2)}\n`;

/**
 * A stable UUID-shaped id from a seed, so the same workflow imports over itself
 * (overwrite matches by id) instead of arriving as a second copy.
 */
export function stableId(seed        )         {
  const round = (start        )         => {
    let h = start >>> 0;
    for (const ch of seed) {
      h ^= ch.codePointAt(0) ?? 0;
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
  };
  const hex = round(0x811c9dc5) + round(0x01234567) + round(0x9e3779b9) + round(0x7f4a7c15);
  const variant = ((parseInt(hex.charAt(16), 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function templateSlug(name        )         {
  return slugOf(name, 'template');
}

// ---------------------------------------------------------------------------
// Cloud templates

/**
 * blueprint.yaml: name, version and description first, then the template.
 *
 * The git integration skips a file without name and version; the API and the
 * upload dialogs accept them as ordinary top-level keys.
 */
export function blueprintYaml(template                  )         {
  const body = template.yaml.replace(/\s+$/, '');
  const lines = body.split('\n');
  // Keep the template's own leading comment block above the header, so the file
  // still opens with what it is, and put name/version before any key.
  const firstKey = lines.findIndex((line) => line.trim() !== '' && !line.trimStart().startsWith('#'));
  const head = firstKey < 0 ? lines : lines.slice(0, firstKey);
  const rest = firstKey < 0 ? [] : lines.slice(firstKey);
  const hasFormat = rest.some((line) => /^formatVersion:/.test(line));
  return [
    ...head,
    `name: ${y(template.name)}`,
    `version: ${template.version ?? '1.0.0'}`,
    `description: ${y(template.description)}`,
    ...(hasFormat ? [] : ['formatVersion: 1']),
    ...rest,
    '',
  ].join('\n');
}

export function templatePath(template                  )         {
  return `import/templates/${templateSlug(template.name)}/blueprint.yaml`;
}

// ---------------------------------------------------------------------------
// Shell: the authentication and HTTP block every import script shares

function importPreamble(purpose                   , opts                                          )           {
  return [
    '#!/usr/bin/env bash',
    ...purpose.map((line) => `# ${line}`),
    '#',
    '# Credentials, first match wins. None is written in this file or passed on a',
    '# command line: files are read by jq and sent on stdin, and the bearer token',
    '# reaches curl as a config on a file descriptor.',
    '#   VCFA_TOKEN                        a bearer token you already have',
    '#   VCFA_API_TOKEN_FILE + VCFA_ORG    VCF Automation 9.x: an organization API token',
    '#                                     (mode-600 file), exchanged at /oauth/tenant/$VCFA_ORG/token',
    '#',
    `# Usage: ${opts.flags}`,
    '# Without --execute it reads, checks and prints what it would do. Nothing changes.',
    'set -euo pipefail',
    '',
    'HERE=$(cd "$(dirname "$0")" && pwd)',
    ': "${VCFA_HOST:?set VCFA_HOST, e.g. vcfa.example.com}"',
    'VCFA_URL="https://${VCFA_HOST}"',
    ...(opts.needsProject ? [': "${VCFA_PROJECT_ID:?set VCFA_PROJECT_ID to the project id — GET /iaas/api/projects, or the project page URL}"'] : []),
    'command -v jq >/dev/null || { echo "jq is required" >&2; exit 2; }',
    'command -v curl >/dev/null || { echo "curl is required" >&2; exit 2; }',
    '',
    'secret_file_ok() {',
    '  local p',
    '  p=$(stat -c %a "$1" 2>/dev/null || stat -f %Lp "$1")',
    '  [[ "$p" == 600 || "$p" == 400 ]] || { echo "$1 is mode $p; make it 600 so only its owner can read it" >&2; exit 2; }',
    '}',
    'if [[ -z "${VCFA_TOKEN:-}" ]]; then',
    '  if [[ -n "${VCFA_API_TOKEN_FILE:-}" ]]; then',
    '    : "${VCFA_ORG:?set VCFA_ORG to the organization name, as it appears in its login URL}"',
    '    secret_file_ok "$VCFA_API_TOKEN_FILE"',
    "    RESP=$( { printf 'grant_type=refresh_token&refresh_token='; jq -jn --rawfile p \"$VCFA_API_TOKEN_FILE\" '$p | rtrimstr(\"\\n\") | @uri'; } |",
    '      curl -sS -f -X POST "${VCFA_URL}/oauth/tenant/${VCFA_ORG}/token" -H "Accept: application/*" -H "Content-Type: application/x-www-form-urlencoded" --data-binary @-)',
    "    VCFA_TOKEN=$(jq -r '.access_token // empty' <<<\"$RESP\")",
    "    NEW_REFRESH=$(jq -r '.refresh_token // empty' <<<\"$RESP\")",
    "    if [[ -n \"$NEW_REFRESH\" && \"$NEW_REFRESH\" != \"$(tr -d '\\n' < \"$VCFA_API_TOKEN_FILE\")\" ]]; then",
    "      ( umask 077; printf '%s\\n' \"$NEW_REFRESH\" > \"${VCFA_API_TOKEN_FILE}.new\" ) && mv \"${VCFA_API_TOKEN_FILE}.new\" \"$VCFA_API_TOKEN_FILE\"",
    '      echo "Token rotation is on: ${VCFA_API_TOKEN_FILE} now holds the new API token; the old one no longer works." >&2',
    '    fi',
    '    unset RESP NEW_REFRESH',
    '  fi',
    'fi',
    '[[ -n "${VCFA_TOKEN:-}" ]] || { echo "No token: set VCFA_TOKEN, or VCFA_API_TOKEN_FILE and VCFA_ORG" >&2; exit 2; }',
    '',
    "auth_cfg() { printf 'header = \"Authorization: Bearer %s\"\\n' \"$VCFA_TOKEN\"; }",
    'TMP=$(mktemp -d "${TMPDIR:-/tmp}/atk-import.XXXXXX")',
    'trap \'rm -rf "$TMP"\' EXIT',
    '',
    '# call METHOD URL [BODY_FILE] — the answer goes to $TMP/out, the HTTP status to stdout.',
    'call() {',
    '  if [[ -n "${3:-}" ]]; then',
    '    curl -sS -o "$TMP/out" -w \'%{http_code}\' -K <(auth_cfg) -X "$1" "$2" -H "Accept: application/json" -H "Content-Type: application/json" --data-binary @"$3"',
    '  else',
    '    curl -sS -o "$TMP/out" -w \'%{http_code}\' -K <(auth_cfg) -X "$1" "$2" -H "Accept: application/json"',
    '  fi',
    '}',
    'ok() { [[ "$1" == 2?? ]]; }',
    '# must STATUS WHAT — stop on anything but 2xx, showing what the server said.',
    'must() {',
    '  ok "$1" && return 0',
    '  echo "$2 failed: HTTP $1" >&2',
    '  head -c 2000 "$TMP/out" >&2 || true',
    '  echo >&2',
    '  exit 1',
    '}',
    "uri() { jq -rn --arg v \"$1\" '$v | @uri'; }",
    '',
  ];
}

/**
 * import/import-templates.sh: validate, create or update, and version every
 * template under import/templates, through the blueprint API.
 */
export function importTemplatesScript()         {
  return [
    ...importPreamble(
      [
        'Import every cloud template under templates/ into VCF Automation, through the',
        'blueprint API: validate it, create it (or update the draft of the template with',
        'the same name in the same project), then create the version named in its',
        'version: line. --release releases that version to the catalog.',
      ],
      { needsProject: true, flags: './import-templates.sh [--execute] [--release]' },
    ),
    'DRY_RUN=1; RELEASE=0',
    'for a in "$@"; do case "$a" in --execute) DRY_RUN=0 ;; --release) RELEASE=1 ;; *) echo "unknown option $a" >&2; exit 2 ;; esac; done',
    'if (( RELEASE )); then WILL=" and release it to the catalog"; DONE=", released to the catalog"; else WILL=" (not released — add --release, or release it from Version History)"; DONE="$WILL"; fi',
    '',
    '# field FILE KEY — a top-level scalar from blueprint.yaml, with its quotes removed.',
    'field() {',
    '  local raw',
    '  raw=$(sed -n "s/^$2:[[:space:]]*//p" "$1" | head -n 1)',
    "  jq -rn --arg s \"$raw\" '$s | if startswith(\"\\\"\") then fromjson else . end'",
    '}',
    '',
    'PROBLEMS=0; COUNT=0',
    'for FILE in "$HERE"/templates/*/blueprint.yaml; do',
    '  [[ -f "$FILE" ]] || continue',
    '  COUNT=$((COUNT + 1))',
    '  NAME=$(field "$FILE" name); VERSION=$(field "$FILE" version); DESC=$(field "$FILE" description)',
    '  if [[ -z "$NAME" || -z "$VERSION" ]]; then',
    '    echo "${FILE#"$HERE"/}: no name: or version: line at the top — skipped" >&2; PROBLEMS=$((PROBLEMS + 1)); continue',
    '  fi',
    '  echo "== ${NAME} ${VERSION}  (${FILE#"$HERE"/})"',
    '  jq -n --arg n "$NAME" --arg d "$DESC" --arg p "$VCFA_PROJECT_ID" --rawfile c "$FILE" \\',
    "    '{name: $n, description: $d, projectId: $p, requestScopeOrg: false, content: $c}' > \"$TMP/body.json\"",
    '',
    '  # 1. Validate. The server parses and checks the template; nothing is saved.',
    '  S=$(call POST "$VCFA_URL/blueprint/api/blueprint-validation" "$TMP/body.json")',
    '  if ok "$S"; then',
    "    jq -r '.validationMessages[]? | \"   \\(.type // \"INFO\"): \\(.message // tostring)\\(if .path then \" (\" + .path + \")\" else \"\" end)\"' \"$TMP/out\"",
    "    if [[ \"$(jq -r '.valid' \"$TMP/out\")\" == false ]]; then",
    '      echo "   INVALID — not imported. Fix what is listed above." >&2; PROBLEMS=$((PROBLEMS + 1)); continue',
    '    fi',
    '    echo "   valid"',
    '  else',
    '    echo "   validation answered HTTP $S — carrying on; creating it validates again" >&2',
    '  fi',
    '',
    '  # 2. Create it, or update the draft of the one template with this name in this project.',
    '  S=$(call GET "$VCFA_URL/blueprint/api/blueprints?name=$(uri "$NAME")&size=200")',
    '  must "$S" "Listing templates named $NAME"',
    "  MATCH=$(jq -c --arg n \"$NAME\" --arg p \"$VCFA_PROJECT_ID\" '[.content[]? | select(.name == $n and ((.projectId // $p) == $p)) | .id]' \"$TMP/out\")",
    "  case $(jq length <<<\"$MATCH\") in",
    '    0) ID="" ;;',
    "    1) ID=$(jq -r '.[0]' <<<\"$MATCH\") ;;",
    '    *) echo "   more than one template named \\"$NAME\\" in this project — skipped; tidy them first" >&2; PROBLEMS=$((PROBLEMS + 1)); continue ;;',
    '  esac',
    '  if (( DRY_RUN )); then',
    '    if [[ -n "$ID" ]]; then echo "   DRY RUN: would update the draft of template $ID"; else echo "   DRY RUN: would create it in project $VCFA_PROJECT_ID"; fi',
    '    echo "   DRY RUN: would create version ${VERSION}${WILL}"',
    '    continue',
    '  fi',
    '  if [[ -n "$ID" ]]; then',
    '    S=$(call PUT "$VCFA_URL/blueprint/api/blueprints/$ID" "$TMP/body.json"); must "$S" "Updating $NAME"',
    '    echo "   updated the draft of $ID"',
    '  else',
    '    S=$(call POST "$VCFA_URL/blueprint/api/blueprints" "$TMP/body.json"); must "$S" "Creating $NAME"',
    "    ID=$(jq -r '.id // empty' \"$TMP/out\")",
    '    [[ -n "$ID" ]] || { echo "   the create call answered without an id" >&2; exit 1; }',
    '    echo "   created $ID"',
    '  fi',
    '',
    '  # 3. Version it. Versions are immutable, so an existing number is left alone.',
    '  S=$(call GET "$VCFA_URL/blueprint/api/blueprints/$ID/versions?size=200"); must "$S" "Listing versions of $NAME"',
    "  if jq -e --arg v \"$VERSION\" 'any(.content[]?; .version == $v)' \"$TMP/out\" >/dev/null; then",
    '    echo "   version $VERSION already exists — raise version: in blueprint.yaml to publish this change" >&2',
    '    continue',
    '  fi',
    '  jq -n --arg v "$VERSION" --arg d "$DESC" --argjson r "$RELEASE" \\',
    "    '{version: $v, description: $d, changeLog: \"Imported by ArchToolKit import-templates.sh\", release: ($r == 1)}' > \"$TMP/version.json\"",
    '  S=$(call POST "$VCFA_URL/blueprint/api/blueprints/$ID/versions" "$TMP/version.json"); must "$S" "Versioning $NAME"',
    '  echo "   version ${VERSION} created${DONE}"',
    "  printf '%s\\t%s\\t%s\\n' \"$NAME\" \"$ID\" \"$VERSION\" >> \"$HERE/imported-templates.txt\"",
    'done',
    '',
    '(( COUNT > 0 )) || { echo "No templates/*/blueprint.yaml beside this script" >&2; exit 2; }',
    'if (( DRY_RUN )); then echo "Nothing was changed. Re-run with --execute (and --release to publish to the catalog)."; fi',
    'exit $(( PROBLEMS > 0 ? 1 : 0 ))',
    '',
    '# Undo: DELETE /blueprint/api/blueprints/{id} (ids are in imported-templates.txt) while',
    '# nothing is deployed from it; or unrelease a version with',
    '# POST /blueprint/api/blueprints/{id}/versions/{version}/actions/unrelease.',
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// ABX

function abxSlug(action             )         {
  return slugOf(action.name, 'abx-action');
}

function abxExt(action             )         {
  return action.runtime === 'python' ? 'py' : 'js';
}

/** The body POST /abx/api/resources/actions takes, less source, projectId and orgId. */
function abxActionJson(action             )                          {
  return {
    name: action.name,
    description: action.description,
    actionType: 'SCRIPT',
    runtime: action.runtime,
    entrypoint: 'handler',
    inputs: action.inputs ?? {},
    timeoutSeconds: action.timeoutSeconds,
    memoryInMB: action.memoryInMB ?? 300,
    dependencies: '',
    shared: false,
  };
}

/** The .abx descriptor beside the script: the exported / git form. VERIFY. */
function abxDescriptor(action             )         {
  const inputs = Object.entries(action.inputs ?? {});
  return [
    '---',
    '# ABX action descriptor, in the form exported actions and git repositories use:',
    '# this file and the script with the same base name, side by side.',
    '# VERIFY against an action exported from your own release before relying on the',
    '# git route; create-abx-action.sh (the API) does not read this file.',
    'exportVersion: "1"',
    `exportId: ${y(stableId(`abx:${action.name}`).replace(/-/g, ''))}`,
    `name: ${y(action.name)}`,
    `runtime: ${y(action.runtime)}`,
    'entrypoint: "handler"',
    ...(inputs.length > 0 ? ['inputs:', ...inputs.map(([key, value]) => `  ${key}: ${JSON.stringify(value)}`)] : ['inputs: {}']),
    `timeoutSeconds: ${action.timeoutSeconds}`,
    'deploymentTimeoutSeconds: 600',
    'actionType: "SCRIPT"',
    `memoryInMB: ${action.memoryInMB ?? 300}`,
    '',
  ].join('\n');
}

export function createAbxScript()         {
  return [
    ...importPreamble(
      [
        'Create, or update, every ABX action under abx/ in VCF Automation through the',
        'ABX API, in the project VCFA_PROJECT_ID; then create its event subscription',
        '(abx/<action>/subscription.json), disabled, with the new action id filled in.',
        'The ids of new actions are appended to abx/created-ids.txt.',
      ],
      { needsProject: true, flags: './create-abx-action.sh [--execute]' },
    ),
    'DRY_RUN=1',
    'for a in "$@"; do case "$a" in --execute) DRY_RUN=0 ;; *) echo "unknown option $a" >&2; exit 2 ;; esac; done',
    '',
    '# The organization id comes from the project, so nothing here has to be typed twice.',
    'S=$(call GET "$VCFA_URL/iaas/api/projects/$VCFA_PROJECT_ID"); must "$S" "Reading project $VCFA_PROJECT_ID"',
    "ORG_ID=$(jq -r '.orgId // empty' \"$TMP/out\")",
    "echo \"Project: $(jq -r '.name // \"?\"' \"$TMP/out\") ($VCFA_PROJECT_ID)\"",
    '',
    'COUNT=0',
    'for DIR in "$HERE"/abx/*/; do',
    '  [[ -f "$DIR/action.json" ]] || continue',
    '  SRC=""',
    '  for f in "$DIR"*.py "$DIR"*.js; do [[ -f "$f" ]] && { SRC="$f"; break; }; done',
    '  [[ -n "$SRC" ]] || { echo "${DIR}: no .py or .js script beside action.json" >&2; exit 2; }',
    '  COUNT=$((COUNT + 1))',
    "  NAME=$(jq -r '.name' \"$DIR/action.json\")",
    '  echo "== ${NAME}  (${SRC#"$HERE"/})"',
    "  jq --rawfile s \"$SRC\" --arg p \"$VCFA_PROJECT_ID\" --arg o \"$ORG_ID\" \\",
    "    '. + {source: $s, projectId: $p} + (if $o == \"\" then {} else {orgId: $o} end)' \"$DIR/action.json\" > \"$TMP/action.json\"",
    '',
    '  # One action with this name in this project, or none.',
    "  S=$(call GET \"$VCFA_URL/abx/api/resources/actions?%24filter=$(uri \"name eq '$NAME'\")&size=200\")",
    '  must "$S" "Listing ABX actions"',
    "  IDS=$(jq -c --arg n \"$NAME\" --arg p \"$VCFA_PROJECT_ID\" '[.content[]? | select(.name == $n and .projectId == $p) | .id]' \"$TMP/out\")",
    "  case $(jq length <<<\"$IDS\") in",
    '    0) ID="" ;;',
    "    1) ID=$(jq -r '.[0]' <<<\"$IDS\") ;;",
    '    *) echo "   more than one action named \\"$NAME\\" in this project — stopping" >&2; exit 1 ;;',
    '  esac',
    '  if (( DRY_RUN )); then',
    '    if [[ -n "$ID" ]]; then echo "   DRY RUN: would update action $ID"; else echo "   DRY RUN: would create it"; fi',
    "    [[ -f \"$DIR/subscription.json\" ]] && echo \"   DRY RUN: would create subscription \\\"$(jq -r '.name' \"$DIR/subscription.json\")\\\" on $(jq -r '.eventTopicId' \"$DIR/subscription.json\"), disabled\"",
    '    continue',
    '  fi',
    '  if [[ -n "$ID" ]]; then',
    "    jq --arg id \"$ID\" '. + {id: $id}' \"$TMP/action.json\" > \"$TMP/update.json\"",
    '    S=$(call PUT "$VCFA_URL/abx/api/resources/actions/$ID" "$TMP/update.json"); must "$S" "Updating $NAME"',
    '    echo "   updated $ID"',
    '  else',
    '    S=$(call POST "$VCFA_URL/abx/api/resources/actions" "$TMP/action.json"); must "$S" "Creating $NAME"',
    "    ID=$(jq -r '.id // empty' \"$TMP/out\")",
    '    [[ -n "$ID" ]] || { echo "   the create call answered without an id" >&2; exit 1; }',
    '    echo "   created $ID"',
    "    printf '%s\\t%s\\n' \"$NAME\" \"$ID\" >> \"$HERE/abx/created-ids.txt\"",
    '  fi',
    '',
    '  # The subscription: created disabled, never twice.',
    '  if [[ -f "$DIR/subscription.json" ]]; then',
    "    SUB=$(jq -r '.name' \"$DIR/subscription.json\")",
    "    S=$(call GET \"$VCFA_URL/event-broker/api/subscriptions?%24filter=$(uri \"name eq '$SUB'\")\")",
    '    must "$S" "Listing subscriptions"',
    "    if jq -e --arg n \"$SUB\" 'any(.content[]?; .name == $n)' \"$TMP/out\" >/dev/null; then",
    '      echo "   subscription \\"$SUB\\" already exists — left as it is; point it at $ID in the interface if it is not already"',
    '    else',
    '      SUB_ID=$(cat /proc/sys/kernel/random/uuid 2>/dev/null || uuidgen | tr "[:upper:]" "[:lower:]")',
    "      jq --arg r \"$ID\" --arg s \"$SUB_ID\" \\",
    "        '.runnableId = $r | .id = (.id // $s) | if (.criteria | type) == \"string\" and (.criteria | startswith(\"<\")) then del(.criteria) else . end' \\",
    '        "$DIR/subscription.json" > "$TMP/subscription.json"',
    '      S=$(call POST "$VCFA_URL/event-broker/api/subscriptions" "$TMP/subscription.json"); must "$S" "Creating subscription $SUB"',
    '      echo "   subscription \\"$SUB\\" created, disabled — enable it once its criteria are right"',
    '    fi',
    '  fi',
    'done',
    '',
    '(( COUNT > 0 )) || { echo "No abx/*/action.json beside this script" >&2; exit 2; }',
    'if (( DRY_RUN )); then echo "Nothing was changed. Re-run with --execute."; fi',
    '',
    '# Undo: DELETE /event-broker/api/subscriptions/{id} first, then',
    '# DELETE /abx/api/resources/actions/{id} (ids in abx/created-ids.txt).',
    '',
  ].join('\n');
}

export function packageAbxScript()         {
  return [
    '#!/usr/bin/env bash',
    '# Build the zip that Extensibility → Library → Actions → New → Import package takes,',
    '# for each action under abx/. The script goes in at the root of the zip as',
    '# main.py (or main.js), so the Main function to enter is main.handler.',
    '# Local only: it reads the files beside it and writes abx/<action>-package.zip.',
    'set -euo pipefail',
    'HERE=$(cd "$(dirname "$0")" && pwd)',
    'command -v zip >/dev/null || { echo "zip is required (or run package-abx.ps1)" >&2; exit 2; }',
    'for DIR in "$HERE"/abx/*/; do',
    '  SRC=""',
    '  for f in "$DIR"*.py "$DIR"*.js; do [[ -f "$f" ]] && { SRC="$f"; break; }; done',
    '  [[ -n "$SRC" ]] || continue',
    '  EXT="${SRC##*.}"',
    '  SLUG=$(basename "$DIR")',
    '  STAGE=$(mktemp -d "${TMPDIR:-/tmp}/atk-abx.XXXXXX")',
    '  cp "$SRC" "$STAGE/main.$EXT"',
    '  OUT="$HERE/abx/$SLUG-package.zip"',
    '  rm -f "$OUT"',
    '  ( cd "$STAGE" && zip -q -X "$OUT" "main.$EXT" )',
    '  rm -rf "$STAGE"',
    '  echo "$OUT   Main function: main.handler"',
    'done',
    '',
  ].join('\n');
}

export function packageAbxPs1()         {
  return [
    '# Build the zip that Extensibility > Library > Actions > New > Import package takes,',
    '# for each action under abx\\. The script goes in at the root of the zip as main.py',
    '# (or main.js), so the Main function to enter is main.handler. Local only.',
    '# PowerShell 5.1 or 7.',
    "$ErrorActionPreference = 'Stop'",
    '$here = Split-Path -Parent $MyInvocation.MyCommand.Path',
    "Get-ChildItem -Path (Join-Path $here 'abx') -Directory | ForEach-Object {",
    "  $src = Get-ChildItem -Path $_.FullName -File | Where-Object { $_.Extension -in @('.py', '.js') } | Select-Object -First 1",
    '  if (-not $src) { return }',
    '  $stage = Join-Path ([System.IO.Path]::GetTempPath()) ([System.Guid]::NewGuid().ToString())',
    '  New-Item -ItemType Directory -Path $stage | Out-Null',
    "  Copy-Item -Path $src.FullName -Destination (Join-Path $stage ('main' + $src.Extension))",
    "  $out = Join-Path (Join-Path $here 'abx') ($_.Name + '-package.zip')",
    "  Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $out -Force",
    '  Remove-Item -Recurse -Force $stage',
    '  Write-Output "$out   Main function: main.handler"',
    '}',
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Orchestrator

function xmlAttr(text        )         {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function cdata(text        )         {
  return `<![CDATA[${text.replace(/]]>/g, ']]]]><![CDATA[>')}]]>`;
}

function paramXml(param          , indent        )         {
  const head = `${indent}<param name="${xmlAttr(param.name)}" type="${xmlAttr(param.type)}"`;
  return param.description ? `${head}>\n${indent}  <description>${cdata(param.description)}</description>\n${indent}</param>` : `${head}/>`;
}

export function workflowId(workflow                     )         {
  return stableId(`vro-workflow:${workflow.category}/${workflow.name}`);
}

/**
 * The workflow XML: a start at item1 (root-name), one scriptable task bound to
 * every input and output, and an explicit end item — the shape vRO itself
 * writes, with editor-version 2.0 and no allowed-operations (which would mark
 * it read-only in the editor).
 */
export function workflowXml(workflow                     )         {
  const bind = (p          ) => `        <bind name="${xmlAttr(p.name)}" type="${xmlAttr(p.type)}" export-name="${xmlAttr(p.name)}"/>`;
  return [
    "<?xml version='1.0' encoding='UTF-8'?>",
    `<workflow xmlns="http://vmware.com/vco/workflow" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://vmware.com/vco/workflow http://vmware.com/vco/workflow/Workflow-v4.xsd" root-name="item1" object-name="workflow:name=generic" id="${workflowId(workflow)}" editor-version="2.0" version="1.0.0" api-version="6.0.0" restartMode="1" resumeFromFailedMode="0">`,
    `  <display-name>${cdata(workflow.name)}</display-name>`,
    `  <description>${cdata(workflow.description)}</description>`,
    '  <position y="50.0" x="100.0"/>',
    ...(workflow.inputs.length > 0 ? ['  <input>', ...workflow.inputs.map((p) => paramXml(p, '    ')), '  </input>'] : ['  <input/>']),
    ...(workflow.outputs.length > 0 ? ['  <output>', ...workflow.outputs.map((p) => paramXml(p, '    ')), '  </output>'] : ['  <output/>']),
    '  <workflow-item name="item0" type="end" end-mode="0">',
    '    <in-binding/>',
    '    <out-binding/>',
    '    <position y="50.0" x="420.0"/>',
    '  </workflow-item>',
    '  <workflow-item name="item1" out-name="item0" type="task">',
    `    <display-name>${cdata(workflow.taskName ?? 'Scriptable task')}</display-name>`,
    `    <script encoded="false">${cdata(workflow.script)}</script>`,
    ...(workflow.inputs.length > 0 ? ['    <in-binding>', ...workflow.inputs.map(bind), '    </in-binding>'] : ['    <in-binding/>']),
    ...(workflow.outputs.length > 0 ? ['    <out-binding>', ...workflow.outputs.map(bind), '    </out-binding>'] : ['    <out-binding/>']),
    `    <description>${cdata('Generated by ArchToolKit.')}</description>`,
    '    <position y="60.0" x="240.0"/>',
    '  </workflow-item>',
    '</workflow>',
    '',
  ].join('\n');
}

const WORKFLOW_INFO = ['type=workflow', 'version=2.0', 'charset=UTF-16', 'unicode=true', 'creator=www.dunes.ch', 'owner=', ''].join('\n');

function workflowSlug(workflow                     )         {
  return slugOf(workflow.name, 'workflow');
}

export function importOrchestratorScript()         {
  const build = [
    '# build DIR OUT — pack workflow-info and workflow-content.xml into a .workflow file.',
    '# vRO reads workflow-content as UTF-16BE with a big-endian BOM; a little-endian',
    '# BOM is rejected on import. The XML declaration stays as vRO writes it.',
    'build() {',
    "  python3 - \"$1\" \"$2\" <<'PY'",
    'import sys, zipfile',
    'src, out = sys.argv[1], sys.argv[2]',
    "with open(src + '/workflow-content.xml', encoding='utf-8') as f:",
    '    content = f.read()',
    "with open(src + '/workflow-info', encoding='utf-8') as f:",
    '    info = f.read()',
    "with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:",
    "    z.writestr('workflow-info', info.encode('utf-8'))",
    "    z.writestr('workflow-content', b'\\xfe\\xff' + content.encode('utf-16-be'))",
    'PY',
    '}',
  ];
  const preamble = importPreamble(
    [
      'Put the Orchestrator content under orchestrator/ into the Orchestrator of VCF',
      'Automation: actions are created (or updated) from JSON through /vco/api/actions;',
      'workflows are built into .workflow files in orchestrator/build/ and imported',
      'into their folder with POST /vco/api/workflows, overwriting the same workflow id.',
      '',
      '--build-only builds the .workflow files and stops, without logging in: import',
      'them by hand from the Orchestrator client (Library → Workflows → Import).',
      '',
      'VRO_HOST: the Orchestrator host, when it is not VCFA_HOST (an external vRO).',
      'VRO_CATEGORY_ID: the folder id, when the folder name is not unique.',
    ],
    { needsProject: false, flags: './import-orchestrator.sh [--execute | --build-only]' },
  );
  // --build-only has to work before any credential is asked for, so it runs
  // ahead of the login part of the preamble.
  const loginAt = preamble.indexOf('HERE=$(cd "$(dirname "$0")" && pwd)');
  return [
    ...preamble.slice(0, loginAt + 1),
    '',
    'DRY_RUN=1; BUILD_ONLY=0',
    'for a in "$@"; do case "$a" in --execute) DRY_RUN=0 ;; --build-only) BUILD_ONLY=1 ;; *) echo "unknown option $a" >&2; exit 2 ;; esac; done',
    '',
    ...build,
    '',
    'mkdir -p "$HERE/orchestrator/build"',
    'BUILT=()',
    'for META in "$HERE"/orchestrator/workflows/*/workflow.json; do',
    '  [[ -f "$META" ]] || continue',
    '  command -v python3 >/dev/null || { echo "python3 is required to build .workflow files" >&2; exit 2; }',
    '  DIR=$(dirname "$META"); SLUG=$(basename "$DIR")',
    '  build "$DIR" "$HERE/orchestrator/build/$SLUG.workflow"',
    '  echo "built orchestrator/build/$SLUG.workflow"',
    '  BUILT+=("$META")',
    'done',
    'if (( BUILD_ONLY )); then',
    '  echo "Import each .workflow from the Orchestrator client: Library → Workflows → Import, into the folder in its workflow.json."',
    '  exit 0',
    'fi',
    '',
    ...preamble.slice(loginAt + 1),
    'VRO_URL="https://${VRO_HOST:-$VCFA_HOST}/vco/api"',
    'PROBLEMS=0',
    '',
    '# 1. Actions. The module is created with the first action in it.',
    'for DESC in "$HERE"/orchestrator/actions/*/*.json; do',
    '  [[ -f "$DESC" ]] || continue',
    '  JS="${DESC%.json}.js"',
    "  MODULE=$(jq -r '.module' \"$DESC\"); NAME=$(jq -r '.name' \"$DESC\")",
    '  echo "== action ${MODULE}/${NAME}"',
    "  jq --rawfile s \"$JS\" '. + {script: $s}' \"$DESC\" > \"$TMP/action.json\"",
    '  S=$(call GET "$VRO_URL/actions/$(uri "$MODULE")/$(uri "$NAME")")',
    '  case "$S" in',
    "    200) ID=$(jq -r '.id' \"$TMP/out\"); VER=$(jq -r '.version // \"1.0.0\"' \"$TMP/out\") ;;",
    '    404) ID="" ;;',
    '    *) must "$S" "Looking up action $MODULE/$NAME" ;;',
    '  esac',
    '  if (( DRY_RUN )); then',
    '    if [[ -n "$ID" ]]; then echo "   DRY RUN: would update action $ID"; else echo "   DRY RUN: would create it (and the module, if new)"; fi',
    '    continue',
    '  fi',
    '  if [[ -n "$ID" ]]; then',
    "    jq --arg id \"$ID\" --arg v \"$VER\" '. + {id: $id, version: $v}' \"$TMP/action.json\" > \"$TMP/update.json\"",
    '    S=$(call PUT "$VRO_URL/actions/$ID" "$TMP/update.json"); must "$S" "Updating $MODULE/$NAME"',
    '    echo "   updated $ID"',
    '  else',
    '    S=$(call POST "$VRO_URL/actions" "$TMP/action.json"); must "$S" "Creating $MODULE/$NAME"',
    "    echo \"   created $(jq -r '.id // \"(id in the Orchestrator client)\"' \"$TMP/out\" 2>/dev/null || echo)\"",
    '  fi',
    'done',
    '',
    '# 2. Workflows, into the folder named in each workflow.json.',
    'if (( ${#BUILT[@]} > 0 )); then',
    '  S=$(call GET "$VRO_URL/categories?categoryType=WorkflowCategory"); must "$S" "Listing workflow folders"',
    '  cp "$TMP/out" "$TMP/categories.json"',
    'fi',
    'for META in "${BUILT[@]}"; do',
    '  DIR=$(dirname "$META"); SLUG=$(basename "$DIR")',
    "  NAME=$(jq -r '.name' \"$META\"); WF_ID=$(jq -r '.id' \"$META\"); FOLDER=$(jq -r '.folder' \"$META\")",
    '  echo "== workflow ${NAME} (${WF_ID}) → ${FOLDER}"',
    '  CAT_ID="${VRO_CATEGORY_ID:-}"',
    '  if [[ -z "$CAT_ID" ]]; then',
    "    CAT_ID=$(jq -r --arg path \"$FOLDER\" --arg leaf \"${FOLDER##*/}\" '",
    '      [ .link[]? | reduce .attributes[]? as $a ({}; .[$a.name] = $a.value) ] as $cats',
    '      | ( [ $cats[] | select((.path // .categoryPath // "") == $path) ] | if length == 1 then .[0].id else empty end )',
    '        // ( [ $cats[] | select(.name == $leaf) ] | if length == 1 then .[0].id else empty end )',
    "        // empty' \"$TMP/categories.json\")",
    '  fi',
    '  if [[ -z "$CAT_ID" ]]; then',
    '    echo "   folder \\"$FOLDER\\" not found, or its name is not unique: create it in the Orchestrator client (Library → Workflows → New folder), or set VRO_CATEGORY_ID" >&2',
    '    PROBLEMS=$((PROBLEMS + 1)); continue',
    '  fi',
    '  if (( DRY_RUN )); then',
    '    echo "   DRY RUN: would import orchestrator/build/$SLUG.workflow into folder $CAT_ID, replacing workflow $WF_ID if it is there"',
    '    continue',
    '  fi',
    '  S=$(curl -sS -o "$TMP/out" -w \'%{http_code}\' -K <(auth_cfg) -X POST "$VRO_URL/workflows?categoryId=$(uri "$CAT_ID")&overwrite=true" \\',
    '    -H "Accept: application/json" -F "categoryId=$CAT_ID" -F "file=@$HERE/orchestrator/build/$SLUG.workflow;type=application/octet-stream")',
    '  must "$S" "Importing $NAME"',
    '  echo "   imported as $WF_ID"',
    'done',
    '',
    'if (( DRY_RUN )); then echo "Nothing was changed in Orchestrator. Re-run with --execute."; fi',
    'exit $(( PROBLEMS > 0 ? 1 : 0 ))',
    '',
    '# Undo: DELETE /vco/api/workflows/{id} and DELETE /vco/api/actions/{id}, or delete them',
    '# in the Orchestrator client. Anything a workflow already did stays done.',
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// The bundle

                               
                                         
                                                                                                     
                   
                                    
                              
                                       
    
 

export function importBundle(spec   
                                                   
                                        
                                                     
                                                         
 )               {
  const files                         = {};
  const templates = spec.templates ?? [];
  const abx = spec.abx ?? [];
  const actions = spec.vroActions ?? [];
  const workflows = spec.vroWorkflows ?? [];

  for (const template of templates) files[templatePath(template)] = blueprintYaml(template);
  if (templates.length > 0) files['import/import-templates.sh'] = importTemplatesScript();

  for (const action of abx) {
    const slug = abxSlug(action);
    files[`import/abx/${slug}/${slug}.${abxExt(action)}`] = action.script;
    files[`import/abx/${slug}/${slug}.abx`] = abxDescriptor(action);
    files[`import/abx/${slug}/action.json`] = json(abxActionJson(action));
    if (action.subscription) {
      const { runnableId: _unused, ...rest } = action.subscription                           ;
      void _unused;
      files[`import/abx/${slug}/subscription.json`] = json(rest);
    }
  }
  if (abx.length > 0) {
    files['import/create-abx-action.sh'] = createAbxScript();
    files['import/package-abx.sh'] = packageAbxScript();
    files['import/package-abx.ps1'] = packageAbxPs1();
  }

  for (const action of actions) {
    files[`import/orchestrator/actions/${action.module}/${action.name}.js`] = action.script;
    files[`import/orchestrator/actions/${action.module}/${action.name}.json`] = json({
      name: action.name,
      module: action.module,
      'input-parameters': action.inputs.map((p) => ({ name: p.name, type: p.type, description: p.description ?? '' })),
      'output-type': action.returnType,
    });
  }
  for (const workflow of workflows) {
    const dir = `import/orchestrator/workflows/${workflowSlug(workflow)}`;
    files[`${dir}/workflow-content.xml`] = workflowXml(workflow);
    files[`${dir}/workflow-info`] = WORKFLOW_INFO;
    files[`${dir}/workflow.json`] = json({ name: workflow.name, id: workflowId(workflow), folder: workflow.category, inputs: workflow.inputs, outputs: workflow.outputs });
  }
  if (actions.length + workflows.length > 0) files['import/import-orchestrator.sh'] = importOrchestratorScript();

  const hasAllApps = templates.some((t) => t.org === 'all-apps');
  const hasVmApps = templates.some((t) => t.org !== 'all-apps');

  return {
    files,
    steps: {
      ...(templates.length > 0
        ? {
            templates: {
              heading: `Cloud template${templates.length > 1 ? 's' : ''} — ${templates.map((t) => `\`${templatePath(t)}\``).join(', ')}`,
              lines: [
                'Each folder is one template in the layout the git integration reads: one folder per template, the file named `blueprint.yaml`, `name:` and `version:` at the top. Pick one route:',
                '',
                '- **Script (any organization type, and Aria Automation 8.x):** `VCFA_HOST=… VCFA_PROJECT_ID=<project id> ./import/import-templates.sh` validates each template on the server and says whether it would create or update it. Add `--execute` to create it (or update the draft of the template with that name in that project) and create the version in `version:`; add `--release` as well to release that version to the catalog. Ids go to `import/imported-templates.txt`.',
                ...(hasVmApps
                  ? ['- **VM Apps organization / Aria Automation 8.x, by hand:** Assembler → Design → Templates → New from → Upload; enter the name and project and choose `blueprint.yaml` (menu labels VERIFY on your release). Then Version, and Release to the catalog.']
                  : []),
                ...(hasAllApps
                  ? ['- **All Apps organization (9.1), by hand:** Build & Deploy → Content Hub → Blueprint Design → Blueprints → New From Import; enter the name and project and choose `blueprint.yaml`, then Import. Version it from the design page (Version History) and release it.']
                  : []),
                '- **Git:** commit the folders under `import/templates/` to a repository connected under Infrastructure → Integrations (GitHub, GitLab or Bitbucket) → Projects, with the type set to cloud templates. VCF Automation imports each valid `blueprint.yaml` on sync; it cannot push changes back.',
                '',
                'A template only deploys once what it names exists: the image and flavor mappings, the cloud zone or namespace class, and any property group or custom resource type it refers to.',
              ],
            },
          }
        : {}),
      ...(abx.length > 0
        ? {
            abx: {
              heading: `ABX action${abx.length > 1 ? 's' : ''} — ${abx.map((a) => `\`import/abx/${abxSlug(a)}/\``).join(', ')}`,
              lines: [
                'Pick one route:',
                '',
                '- **Script:** `VCFA_HOST=… VCFA_PROJECT_ID=<project id> ./import/create-abx-action.sh` shows what it would create. `--execute` creates the action through the ABX API with the script inline (or updates the one with the same name in the project), writes the id of a new action to `import/abx/created-ids.txt`' +
                  (abx.some((a) => a.subscription) ? ', and creates the event subscription from `subscription.json`, disabled, pointing at it.' : '.'),
                `- **By hand:** \`./import/package-abx.sh\` (or \`package-abx.ps1\` on Windows) builds \`import/abx/<action>-package.zip\` with the script at its root. In Assembler (VM Apps organization, or Aria Automation 8.x): Extensibility → Library → Actions → New, pick the project, choose ${abx.map((a) => (a.runtime === 'python' ? 'Python' : 'Node.js')).filter((v, i, all) => all.indexOf(v) === i).join(' / ')}, then Import package, select the zip, and set the Main function to \`main.handler\`. Set the timeout to ${abx.map((a) => `${a.timeoutSeconds}s`).join(' / ')}.` +
                  (abx.some((a) => a.subscription) ? ' Then Extensibility → Subscriptions → New with the topic and settings in `subscription.json`.' : ''),
                '- **Git (VERIFY):** the `<action>.abx` descriptor and the script beside it are the form an exported action and an action repository use; the descriptor format is from community examples, not Broadcom documentation, so export one action from your release and compare before relying on it.',
                '',
                'ABX actions and subscriptions belong to VM Apps organizations (and Aria Automation 8.x). Subscriptions need an organization administrator; a project-level token is refused.',
              ],
            },
          }
        : {}),
      ...(actions.length + workflows.length > 0
        ? {
            orchestrator: {
              heading: `Orchestrator ${[actions.length > 0 ? `action${actions.length > 1 ? 's' : ''}` : '', workflows.length > 0 ? `workflow${workflows.length > 1 ? 's' : ''}` : ''].filter(Boolean).join(' and ')} — \`import/orchestrator/\``,
              lines: [
                ...(workflows.length > 0
                  ? [
                      `First create the workflow folder${new Set(workflows.map((w) => w.category)).size > 1 ? 's' : ''} ${[...new Set(workflows.map((w) => `\`${w.category}\``))].join(', ')} in the Orchestrator client (Library → Workflows → New folder), if it does not exist.`,
                      '',
                    ]
                  : []),
                `- **Script:** \`VCFA_HOST=… ./import/import-orchestrator.sh\` shows what it would do${workflows.length > 0 ? ' and builds the `.workflow` files into `import/orchestrator/build/`' : ''}; \`--execute\` ${[actions.length > 0 ? 'creates or updates the actions through /vco/api/actions (the module is created with its first action)' : '', workflows.length > 0 ? 'imports each workflow into its folder, replacing the same workflow id on a re-run' : ''].filter(Boolean).join(', and ')}. Set VRO_HOST if Orchestrator is not on the VCF Automation host.`,
                ...(workflows.length > 0
                  ? ['- **By hand:** `./import/import-orchestrator.sh --build-only` builds the `.workflow` files without logging in (python3 needed). In the Orchestrator client: Library → Workflows → Import, pick the file and the folder.']
                  : []),
                ...(actions.length > 0
                  ? [`- **Actions by hand:** Library → Actions → New action, module ${[...new Set(actions.map((a) => `\`${a.module}\``))].join(', ')}, name ${actions.map((a) => `\`${a.name}\``).join(', ')}; paste the \`.js\`, add the inputs and return type from the \`.json\` beside it.`]
                  : []),
                '',
                ...(workflows.length > 0 ? [`Workflow ids are fixed (${workflows.map((w) => `${w.name}: \`${workflowId(w)}\``).join('; ')}), so anything that refers to a workflow by id can be written before it is imported.`] : []),
              ],
            },
          }
        : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// IMPORT.md

/** A step that sends JSON payloads with a script beside them. */
export function apiStep(heading        , script        , sends                   , extra                    = [])             {
  return {
    heading,
    lines: [
      `\`./${script}\` shows what it would send; \`./${script} --execute\` sends, in this order:`,
      '',
      ...sends.map((line) => `- ${line}`),
      ...(extra.length > 0 ? ['', ...extra] : []),
    ],
  };
}

/** A step run with kubectl against the VCF Automation (or Supervisor) context. */
export function kubeStep(heading        , script        , files                   , extra                    = [], opts                                       = {})             {
  const run = opts.expectContext === false ? `./${script}` : `EXPECT_CONTEXT=<context> ./${script}`;
  return {
    heading,
    lines: [
      `\`${run}\` runs a server-side dry run; \`--execute\` creates. By hand, the same is \`kubectl create -f ${files.join(' -f ')}\` in the right context — \`create\`, not \`apply\`: the VCF Automation endpoint rejects the annotation \`apply\` adds, and \`create\` refuses to overwrite something that exists.`,
      '',
      'Log in first: `vcf context create <name> --type cci --endpoint https://$VCFA_HOST --tenant-name <org>`, then `vcf context use <name>:<namespace>:<project>`.',
      ...(extra.length > 0 ? ['', ...extra] : []),
    ],
  };
}

export function manualStep(heading        , lines                   )             {
  return { heading, lines };
}

/** The VM Apps setup chain, so each setup blueprint says where it sits. */
const SETUP_ORDER                                         = [
  ['vcfa_cloud_account', 'Cloud account (vSphere, and NSX)'],
  ['vcfa_cloud_zone', 'Cloud zone'],
  ['vcfa_project', 'Project (names the cloud zones)'],
  ['vcfa_mappings', 'Image and flavor mappings'],
  ['vcfa_network_profile', 'Network profile'],
  ['vcfa_storage_profile', 'Storage profile'],
  ['vcfa_naming', 'Custom naming'],
  ['vcfa_property_group', 'Property groups'],
  ['vcfa_catalog', 'Content source and sharing policy'],
  ['vcfa_cloud_template', 'Cloud templates, then approval, lease and day-2 policies'],
];

export function setupOrderStep(current        )             {
  return {
    heading: 'Where this sits in the order',
    lines: [
      'A VM Apps organization (or Aria Automation 8.x) is set up in this order, each from its own blueprint on this page; later objects name the ids of earlier ones:',
      '',
      ...SETUP_ORDER.map(([id, label], index) => `${index + 1}. ${id === current ? `**${label} — this one**` : label} (\`${id}\`)`),
    ],
  };
}

                                                                              

const AUTH_TEXT                                       = {
  import:
    '`import/*.sh`: `VCFA_HOST`, plus `VCFA_TOKEN`, or `VCFA_API_TOKEN_FILE` and `VCFA_ORG` (an organization API token, exchanged at /oauth/tenant/<org>/token). Token files must be mode 600.',
  apply:
    '`apply.sh`: `VCFA_HOST`, plus `VCFA_TOKEN`, or `VCFA_API_TOKEN_FILE` and `VCFA_ORG` (an organization API token, exchanged at /oauth/tenant/<org>/token).',
  vcfa91: 'The 9.1 scripts: `VCFA_HOST`, `VCFA_ORG`, and `VCFA_TOKEN` or `VCFA_API_TOKEN_FILE` (a mode-600 file holding a VCF Automation API token; provider scripts use the provider token).',
  kube: 'kubectl scripts: whatever context `vcf context use` selected, checked against `EXPECT_CONTEXT`. Nothing secret is read from the files.',
  terraform: 'Terraform: `VCFA_URL`, `VCFA_ORG` and `VCFA_API_TOKEN_FILE`; plan.sh reads the token and exports it for the vmware/vcfa provider.',
};

/**
 * IMPORT.md: numbered steps in the order they have to happen, then what each
 * script needs to log in, then what is confirmed and what to check.
 */
export function importMd(opts   
                           
                                                      
                                       
                                      
                         
 )         {
  const steps = opts.steps.filter((step)                     => step !== undefined);
  return [
    '# Importing this into VCF Automation',
    '',
    `${opts.subject}`,
    '',
    `Works with: ${opts.orgs ?? 'VCF Automation 9.1 / 9.1.1 VM Apps organizations, and Aria Automation 8.x where the format is the same'}.`,
    '',
    'Do the steps in order: later ones refer to what earlier ones created. Every script is a dry run until you add `--execute`.',
    '',
    ...steps.flatMap((step, index) => [`## ${index + 1}. ${step.heading}`, '', ...step.lines, '']),
    ...(opts.auth.length > 0 ? ['## Credentials', '', ...opts.auth.map((a) => `- ${AUTH_TEXT[a]}`), ''] : []),
    '## Confirmed, and what to verify',
    '',
    ...(opts.verify ?? []).map((line) => `- ${line}`),
    '- Sources: Broadcom TechDocs 9.1 "Import a Blueprint into VCF Automation" and 9.0 "How do I use Git integration in VCF Automation for VM Apps" (blueprint.yaml, name and version); Aria Automation 8.18 API Programming Guide (blueprint create, validate, version and release); ABX and Orchestrator API references at developer.broadcom.com. Anything marked VERIFY was not in those.',
    '',
  ].join('\n');
}

/** VERIFY lines for the artifact kinds in a bundle. */
export function verifyFor(bundle              )           {
  return [
    ...(bundle.steps.templates
      ? ['Templates: the blueprint API and the git layout are documented. `requestScopeOrg: false` keeps a template to its project. Under a 9.x All Apps organization token the /blueprint/api paths are VERIFY — the UI route (New From Import) is the documented one there.']
      : []),
    ...(bundle.steps.abx
      ? ['ABX: the API field names come from the ABX API specification; PUT to update an existing action, the subscription `id` supplied by the client, and the .abx descriptor are VERIFY. The Import package zip (script at the root, main.handler) is documented.']
      : []),
    ...(bundle.steps.orchestrator
      ? ['Orchestrator: POST /vco/api/workflows (multipart `file`, categoryId, overwrite) is in the Orchestrator API reference; creating an action from JSON and the unsigned .workflow format are not in Broadcom documentation but are recorded as working on vRO 8.18.1 and VCF Automation 9.1.0 by mgovedarov/mcp-vcf-orchestrator. On 9.x, VERIFY that your organization token is accepted at /vco/api (set VRO_HOST for an external Orchestrator).']
      : []),
  ];
}
