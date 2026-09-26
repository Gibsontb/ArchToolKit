/**
 * Getting what the VCF Operations blueprints generate *into* VCF Operations.
 *
 * Every VCF Operations blueprint emits an IMPORT.md that says, file by file and
 * in order, where each one goes; the blueprints that write content also emit an
 * `import/` folder holding that content in the form VCF Operations' own import
 * dialogs take, and a content-management package for the API.
 *
 * What each format is, and where it was established:
 *
 * Alert definitions, symptom definitions and recommendations.
 *   One XML file, root `<alertContent>` with `<AlertDefinitions>`,
 *   `<SymptomDefinitions>` and `<Recommendations>`, imported at Alerts → Alert
 *   Definitions → Import. Taken from real exports: VMware's own
 *   notoriousbdg/vrops-dashboard-guest_needed_memory (8.x; an alert State holds
 *   `<SymptomSets operator>` → `<SymptomSet applyOn operator>` → `<Symptom ref>`,
 *   plus `<Impact key type="badge">` and `<Recommendations>` →
 *   `<Recommendation priority ref>`; a SymptomDefinition carries waitCycle and
 *   cancelCycle and a `<State severity>` → `<Condition key operator
 *   thresholdType type value valueType>`; a Recommendation is `<Recommendation
 *   key><Description>`), and sentania-labs/vcf-content-factory-bundles, whose
 *   AlertContent.xml is shipped for VCF Operations 9 with the same shape.
 *
 * Super metrics.
 *   A JSON object keyed by the super metric's UUID, each value {name, formula,
 *   description, unitId, resourceKinds: [{resourceKindKey, adapterKindKey}]},
 *   imported at Super Metrics → ⋯ → Import (Broadcom, VCF Operations 9.0
 *   "Exporting and Importing a Super Metric": the export is SuperMetric.json,
 *   the import skips a same-named metric unless told to overwrite). Shape from
 *   the notoriousbdg and sentania-labs exports.
 *
 * Views and reports.
 *   A zip holding content.xml, root `<Content>` → `<Views>` → `<ViewDef id>` (or
 *   `<Reports>` → `<ReportDef id>`), imported at Views → Import and Reports →
 *   Import. ViewDef children (Title, Description, SubjectType, Usage, Controls
 *   with time-interval-selector and attributes-selector, DataProviders,
 *   Presentation) and ReportDef children (isTenant, Title, Description,
 *   SubjectType, Sections of ContentType/ContentKey, Settings with
 *   OutputFormat) are from those exports.
 *
 * Dashboards.
 *   A zip holding dashboard/dashboard.json — {entries, dashboards: [...], uuid},
 *   each dashboard with widgets placed by gridsterCoords and wired by
 *   widgetInteractions — imported at Dashboards → Manage → Import. Same sources.
 *
 * Custom groups.
 *   {"customGroups": [...]} in the interface's export shape (name, resourceKind,
 *   adapterKind "Container", autoResolveMembership, membershipDefinition →
 *   ruleGroups → rules with ruleType), imported at Custom Groups → Import. This
 *   is NOT the REST body of POST /api/resources/groups; it is the shape in the
 *   notoriousbdg CustomGroups.json exports.
 *
 * Policies.
 *   GET /api/policies/export?id= returns a zip holding the policy XML
 *   (`<PolicyContent>` → `<Policies>` → `<Policy>` → `<PackageSettings>`), and
 *   POST /api/policies/import?forceImport=true takes that zip as multipart
 *   field `policy` (sentania-labs installer, which round-trips it on 9.x). A
 *   policy XML holds a policy's overrides of its parent, so importing a
 *   fragment would replace every other override: the blueprints merge into an
 *   export instead of writing a policy to import on its own.
 *
 * Content Management (Administration → Control Panel → Content Management →
 * Import; POST /api/content/operations/import, multipart contentFile).
 *   Broadcom, VCF Operations 9.0 "Importing Content": the backup zip, with
 *   "Overwrite existing content" or "Skip". Inside, as the toolkit's own reader
 *   (src/aria/parse.ts) and the exports it was written against have it:
 *   supermetrics.json, customgroups.json, alertdefs.xml, symptomdefs.xml,
 *   recommendationdefs.xml, notificationrules.json, views.zip and reports.zip
 *   (each holding content.xml), dashboards/<owner id> (a dashboard zip),
 *   configuration.json, usermappings.json — and a `<number>L.v1` marker file
 *   whose name is particular to the instance (stephanmctighe.com, "Exporting
 *   Aria Operations Content via the API"; sentania-labs: "the importer rejects
 *   bundles whose marker filename does not match the server's own value"). The
 *   marker cannot be known offline, so the package the blueprints emit leaves
 *   it out and import-content.sh adds the instance's own from a fresh export
 *   before it imports. Uploading the package in the interface without it is
 *   marked VERIFY.
 */

import { authHeader, authPreamble } from './apply.js';
import { automationFiles,                          } from './from-automation.js';
                                                  

const PLATFORM = 'vcf-operations'         ;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Escape text for an XML attribute or element. */
export function xe(text                 )         {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Escape for inside a bash single-quoted string. */
function sq(text        )         {
  return text.replace(/'/g, "'\\''");
}

/**
 * A stable, UUID-shaped id from a name, so a dashboard and the view it shows
 * agree on the view's id without either being generated first.
 */
export function stableId(seed        )         {
  let hex = '';
  for (let round = 0; round < 4; round += 1) {
    let hash = 0x811c9dc5;
    for (const char of `${seed}#${round}`) {
      hash ^= char.charCodeAt(0);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    hex += hash.toString(16).padStart(8, '0');
  }
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** Where the content-management package sits inside the download. */
export const CONTENT_ZIP = 'import/vcfops-content.zip';

/**
 * The user id written into a generated dashboard. A dashboard export carries
 * its owner's id; the interface import takes the dashboard as the importing
 * user, and import-content.sh replaces this with the id of the user it logs in
 * as, because the content import files dashboards by owner.
 */
export const DASHBOARD_OWNER_PLACEHOLDER = '00000000-0000-4000-a000-00000000a7c0';

// ---------------------------------------------------------------------------
// Alert content
// ---------------------------------------------------------------------------

                             
                      
                        
                               
                                
                                                                   
                             
                               
                       
                                                          
                         
 

                           
                      
                        
                               
                               
                                
                        
                           
                                                    
                                                                                      
                                         
                                          
                                                 
 

                                    
                       
                               
 

                               
                                       
                                           
                                                         
 

/** The API's operator names, as the symbols the XML export uses. */
export const XML_OPERATOR                                                   = { GT: '>', GT_EQ: '>=', LT: '<', LT_EQ: '<=', EQ: '=', NOT_EQ: '!=' };

function alertLines(alert          )           {
  return [
    `        <AlertDefinition adapterKind="${xe(alert.adapterKind)}" description="${xe(alert.description)}" id="${xe(alert.id)}" name="${xe(alert.name)}" resourceKind="${xe(alert.resourceKind)}" subType="${alert.subType}" type="${alert.type}">`,
    '            <State severity="automatic">',
    '                <SymptomSets operator="and">',
    `                    <SymptomSet applyOn="self" operator="${alert.symptomOperator}">`,
    ...alert.symptomRefs.map((ref) => `                        <Symptom ref="${xe(ref)}"/>`),
    '                    </SymptomSet>',
    '                </SymptomSets>',
    `                <Impact key="${alert.impact}" type="badge"/>`,
    ...(alert.recommendationRefs.length > 0
      ? ['                <Recommendations>', ...alert.recommendationRefs.map((ref, index) => `                    <Recommendation priority="${index + 1}" ref="${xe(ref)}"/>`), '                </Recommendations>']
      : []),
    '            </State>',
    '        </AlertDefinition>',
  ];
}

function symptomLines(symptom            )           {
  const value = Number.isInteger(symptom.value) ? symptom.value.toFixed(1) : String(symptom.value);
  return [
    `        <SymptomDefinition adapterKind="${xe(symptom.adapterKind)}" cancelCycle="${symptom.cancelCycle}" id="${xe(symptom.id)}" name="${xe(symptom.name)}" resourceKind="${xe(symptom.resourceKind)}" waitCycle="${symptom.waitCycle}">`,
    `            <State severity="${symptom.severity}">`,
    `                <Condition instanced="false" key="${xe(symptom.key)}" operator="${xe(symptom.operator)}" thresholdType="static" type="metric" value="${value}" valueType="numeric"/>`,
    '            </State>',
    '        </SymptomDefinition>',
  ];
}

function recommendationLines(recommendation                   )           {
  return [`        <Recommendation key="${xe(recommendation.key)}">`, `            <Description>${xe(recommendation.description)}</Description>`, '        </Recommendation>'];
}

/**
 * `<alertContent>` as Alerts → Alert Definitions → Import takes it. `only`
 * writes one section, as the content-management package splits them into
 * alertdefs.xml, symptomdefs.xml and recommendationdefs.xml.
 */
export function alertContentXml(content              , only                                            )         {
  const lines = ['<?xml version="1.0" encoding="UTF-8"?>', '<alertContent>'];
  if ((!only || only === 'alerts') && content.alerts.length > 0) lines.push('    <AlertDefinitions>', ...content.alerts.flatMap(alertLines), '    </AlertDefinitions>');
  if ((!only || only === 'symptoms') && content.symptoms.length > 0) lines.push('    <SymptomDefinitions>', ...content.symptoms.flatMap(symptomLines), '    </SymptomDefinitions>');
  if ((!only || only === 'recommendations') && content.recommendations.length > 0) lines.push('    <Recommendations>', ...content.recommendations.flatMap(recommendationLines), '    </Recommendations>');
  lines.push('</alertContent>', '');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Super metrics, custom groups, notification rules
// ---------------------------------------------------------------------------

                                    
                      
                        
                           
                               
                          
                                                                                                           
 

/** SuperMetric.json: an object keyed by the super metric's id. */
export function superMetricsJson(metrics                              )         {
  const out                          = {};
  for (const metric of metrics) {
    out[metric.id] = {
      name: metric.name,
      formula: metric.formula,
      description: metric.description,
      unitId: metric.unitId,
      modificationTime: 0,
      resourceKinds: metric.resourceKinds.map((kind) => ({ resourceKindKey: kind.resourceKindKey, adapterKindKey: kind.adapterKindKey })),
    };
  }
  return `${JSON.stringify(out, null, 2)}\n`;
}

/** One rule in a custom group's export: a metric or property compared with a value. */
                       
                                                                                                                                                                                          
                                                                                                                                                                               
                                                                                                                     

                                    
                        
                               
                                                 
                             
                                
                                                                                  
                                                                                                                                        
 

/** customgroups.json as Custom Groups → Import takes it. */
export function customGroupsJson(groups                              )         {
  return `${JSON.stringify(
    {
      customGroups: groups.map((group) => ({
        resourceKind: group.groupType,
        adapterKind: 'Container',
        name: group.name,
        description: group.description,
        autoResolveMembership: group.autoResolve,
        started: true,
        membershipDefinition: { ruleGroups: group.ruleGroups.map((ruleGroup) => ({ resourceKind: ruleGroup.resourceKind, adapterKind: ruleGroup.adapterKind, rules: ruleGroup.rules })) },
      })),
    },
    null,
    2,
  )}\n`;
}

// ---------------------------------------------------------------------------
// The content-management package
// ---------------------------------------------------------------------------

/**
 * The files of a content-management package, keyed under import/vcfops-content.zip/
 * so the download packs them into one zip. configuration.json says what is in
 * it; the instance marker and, for dashboards, the owner's entries are added by
 * import-content.sh.
 */
export function contentPackage(entries                                  , configuration                                   )                         {
  const files                         = {};
  for (const [path, body] of Object.entries(entries)) files[`${CONTENT_ZIP}/${path}`] = body;
  files[`${CONTENT_ZIP}/configuration.json`] = `${JSON.stringify({ ...configuration, type: 'CUSTOM' }, null, 2)}\n`;
  return files;
}

/** The bash that talks to /content/operations: last_op and export_content. */
function contentOpsLines()           {
  return [
    'API="https://${VCFOPS_HOST}/suite-api/api/content/operations"',
    '# last_op import|export FILE: the last operation into FILE; prints the HTTP code.',
    'last_op() {',
    '  local code',
    `  code=$(curl -sS -o "$2" -w "%{http_code}" "$API/$1" -H "${authHeader(PLATFORM)}" -H "Accept: application/json") || code=000`,
    '  echo "${code:-000}"',
    '}',
    '# export_content TYPE ZIP: export TYPE and wait for *this* export, not an earlier',
    '# one: the last export is read first, and only a status with a different id counts.',
    'export_content() {',
    '  local type="$1" zip="$2" code prev="" id state=""',
    '  code=$(last_op export "$WORK/last-export.json")',
    '  case "$code" in',
    '    200) prev=$(jq -r \'.id // empty\' "$WORK/last-export.json") ;;',
    '    404) prev="" ;;',
    '    *) echo "GET $API/export returned HTTP $code" >&2; return 1 ;;',
    '  esac',
    '  jq -n --arg t "$type" \'{scope: "CUSTOM", contentTypes: [$t]}\' |',
    `    curl -sS -f -X POST "$API/export" -H "${authHeader(PLATFORM)}" -H "Accept: application/json" -H "Content-Type: application/json" --data-binary @- >/dev/null || return 1`,
    '  for _ in $(seq 1 60); do',
    '    sleep 5',
    '    code=$(last_op export "$WORK/export.json")',
    '    [[ "$code" == 200 ]] || continue',
    '    id=$(jq -r \'.id // empty\' "$WORK/export.json")',
    '    [[ -n "$id" && "$id" != "$prev" ]] || continue',
    '    state=$(jq -r \'.state // "UNKNOWN"\' "$WORK/export.json")',
    '    case "$state" in FINISHED|FAILED) break ;; esac',
    '  done',
    '  if [[ "$state" != FINISHED ]]; then',
    '    echo "The $type export did not finish (state: ${state:-no status for this export after 5 minutes})." >&2',
    '    [[ -s "$WORK/export.json" ]] && jq -c \'{state, errorCode, errorMessages}\' "$WORK/export.json" >&2',
    '    return 1',
    '  fi',
    `  curl -sS -f "$API/export/zip" -H "${authHeader(PLATFORM)}" -o "$zip" || return 1`,
    '}',
  ];
}

                                       
                                                  
                        
                                                                                    
                               
                                                                               
                                      
                                                                    
                                                    
 

/**
 * import-content.sh: complete the package in import/vcfops-content.zip and
 * import it through Content Management.
 *
 * Imports when run (--dry-run only builds and lists the package). It exports the same content type first —
 * that export is the backup, and it carries the instance's `<n>L.v1` marker,
 * which is copied into the package — refuses to replace content that is already
 * there unless --overwrite, imports with force=false unless --overwrite (the
 * API reference documents force as defaulting to true), and follows the import
 * by the id its POST returned.
 */
export function contentImportScript(opts                      )         {
  const dash = opts.dashboard;
  return [
    '#!/usr/bin/env bash',
    `# Import ${opts.what} through Content Management`,
    '# (POST /suite-api/api/content/operations/import, multipart contentFile).',
    '#',
    `# It takes the package in ${CONTENT_ZIP} (from the download, or the folder of`,
    '# the same name) and completes it: the content import only accepts a package that',
    '# carries the instance\'s own "<number>L.v1" marker file, which is copied from a',
    `# fresh export of ${opts.contentType}${dash ? ', and a dashboard is filed under the id of the user it is imported as' : ''}.`,
    '#',
    '# With --dry-run this builds the package without the marker, lists it and stops.',
    `# Run without it, it first exports the existing ${opts.contentType} content to`,
    '# pre-import-backup-<time>.zip beside this script — the backup, and the source of the',
    '# marker — and refuses to import if this content is already there (same name or id)',
    '# unless --overwrite is also given. The import is sent with force=false unless',
    '# --overwrite: the API reference says force defaults to true, which overwrites.',
    '#',
    '# Exit 0 only when this import (followed by the id the POST returned) reaches',
    '# FINISHED with nothing failed or skipped; 1 on FAILED, on failed or skipped items,',
    '# on a refusal, or when it has not finished after 10 minutes.',
    'set -euo pipefail',
    '',
    ...authPreamble(PLATFORM),
    'for tool in jq zip unzip curl; do command -v "$tool" >/dev/null || { echo "$tool is required" >&2; exit 2; }; done',
    '',
    'EXECUTE=1',
    'OVERWRITE=0',
    'for arg in "$@"; do',
    '  case "$arg" in',
    '    --dry-run) EXECUTE=0 ;;',
    '    --overwrite) OVERWRITE=1 ;;',
    '    *) echo "Unknown argument $arg. Use --dry-run to preview, and --overwrite to replace existing content." >&2; exit 2 ;;',
    '  esac',
    'done',
    'HERE=$(cd "$(dirname "$0")" && pwd)',
    'WORK=$(umask 077; mktemp -d "${TMPDIR:-/tmp}/work.XXXXXX")',
    `trap 'rm -rf "$WORK" "\${${authHeader(PLATFORM).slice(3, -1)}:-}"' EXIT`,
    '',
    '# unpack SRC DEST: a zip, or the folder of the same name when the files were',
    '# saved one by one rather than as the download.',
    'unpack() {',
    '  mkdir -p "$2"',
    '  if [[ -d "$1" ]]; then cp -R "$1/." "$2/"',
    '  elif [[ -f "$1" ]]; then unzip -q -o "$1" -d "$2"',
    '  else echo "Missing $1 — run this from the unzipped download." >&2; exit 2',
    '  fi',
    '}',
    `unpack "$HERE/${CONTENT_ZIP}" "$WORK/content"`,
    '# A nested package that arrived as a folder is zipped again, as the importer expects.',
    'for nested in views.zip reports.zip; do',
    '  if [[ -d "$WORK/content/$nested" ]]; then',
    '    (cd "$WORK/content/$nested" && zip -qr "$WORK/$nested" .)',
    '    rm -rf "${WORK:?}/content/$nested" && mv "$WORK/$nested" "$WORK/content/$nested"',
    '  fi',
    'done',
    ...(dash
      ? [
          'unpack "$HERE/import/dashboard.zip" "$WORK/dashboard"',
          'OWNER_ID=OWNER-ID-SET-AT-IMPORT',
          'OWNER_NAME=owner',
          '# file_dashboard: dashboards/<owner>, dashboardsharings/<owner> and usermappings.json,',
          '# as a content export has them.',
          'file_dashboard() {',
          '  rm -rf "$WORK/content/dashboards" "$WORK/content/dashboardsharings"',
          '  mkdir -p "$WORK/content/dashboards" "$WORK/content/dashboardsharings"',
          '  rm -rf "$WORK/dash" && mkdir -p "$WORK/dash" && cp -R "$WORK/dashboard/." "$WORK/dash/"',
          `  sed "s/${DASHBOARD_OWNER_PLACEHOLDER}/\${OWNER_ID}/g" "$WORK/dashboard/dashboard/dashboard.json" > "$WORK/dash/dashboard/dashboard.json"`,
          '  # To stdout: given a name with no extension, zip would add .zip to it.',
          '  (cd "$WORK/dash" && zip -qr - .) > "$WORK/content/dashboards/${OWNER_ID}"',
          ...(dash.shared
            ? ['  jq \'[{groupName: "Everyone", sourceType: "LOCAL", dashboards: [.dashboards[] | {dashboardId: .id}]}]\' "$WORK/dash/dashboard/dashboard.json" > "$WORK/content/dashboardsharings/${OWNER_ID}"']
            : ['  rmdir "$WORK/content/dashboardsharings"']),
          '  jq -n --arg u "$OWNER_NAME" --arg i "$OWNER_ID" \'{sources: [], users: [{userName: $u, userId: $i}]}\' > "$WORK/content/usermappings.json"',
          '  n=$(jq \'.dashboards | length\' "$WORK/dash/dashboard/dashboard.json")',
          '  jq --arg o "$OWNER_ID" --argjson n "$n" \'.dashboards = $n | .dashboardsByOwner = [{owner: $o, count: $n}]\' "$WORK/content/configuration.json" > "$WORK/configuration.json"',
          '  mv "$WORK/configuration.json" "$WORK/content/configuration.json"',
          '}',
          'file_dashboard',
        ]
      : []),
    '',
    '# XML escapes the angle bracket, so look for both spellings, inside nested zips too.',
    `required=$( { grep -rlE "<REQUIRED|&lt;REQUIRED" "$WORK/content"${dash ? ' "$WORK/dashboard"' : ''} 2>/dev/null || true; for z in "$WORK"/content/*.zip; do [[ -f "$z" ]] && unzip -p "$z" | grep -qE "<REQUIRED|&lt;REQUIRED" && echo "$z"; done; true; } )`,
    'if [[ -n "$required" ]]; then',
    '  echo "The package still has a <REQUIRED> value in it — fill it in first:" >&2',
    '  echo "$required" | sed "s|$WORK/||" >&2',
    '  exit 2',
    'fi',
    '',
    'OUT="$HERE/vcfops-content-import.zip"',
    'build() { rm -f "$OUT"; (cd "$WORK/content" && zip -qr "$OUT" .); }',
    '',
    'if (( ! EXECUTE )); then',
    '  build',
    '  echo "Built $OUT (without the instance marker, which is added at import):"',
    '  unzip -l "$OUT"',
    `  echo "DRY RUN: would export ${opts.contentType} as a backup, copy its L.v1 marker in, then POST to https://\${VCFOPS_HOST}/suite-api/api/content/operations/import?force=false"`,
    '  echo "Dry run: nothing was changed. Run it without --dry-run to apply."',
    '  exit 0',
    'fi',
    '',
    ...contentOpsLines(),
    '',
    '# 1. Nothing else may be importing now: its status would be read as ours.',
    'code=$(last_op import "$WORK/last-import.json")',
    'case "$code" in',
    '  200) BUSY=$(jq -r \'.state // "UNKNOWN"\' "$WORK/last-import.json") ;;',
    '  404) BUSY=NOT_INITIALIZED ;;',
    '  *) echo "GET $API/import returned HTTP $code" >&2; exit 1 ;;',
    'esac',
    'case "$BUSY" in INITIALIZED|RUNNING) echo "Another content import is $BUSY. Wait for it to finish." >&2; exit 1 ;; esac',
    '',
    `# 2. Back up the ${opts.contentType} content as it is now. The backup also carries`,
    '#    the instance marker the import checks for.',
    'BACKUP="$HERE/pre-import-backup-$(date +%Y%m%d-%H%M%S).zip"',
    `export_content ${opts.contentType} "$BACKUP" || { echo "No backup, so nothing was imported." >&2; exit 1; }`,
    'echo "Backup of the existing content: $BACKUP"',
    'MARKER=$(unzip -Z1 "$BACKUP" | grep -E "L\\.v1$" | head -n 1 || true)',
    '[[ -n "$MARKER" ]] || { echo "The export has no <number>L.v1 marker file; the import would be rejected. VERIFY the export on your release." >&2; exit 1; }',
    'unzip -p "$BACKUP" "$MARKER" > "$WORK/content/$MARKER"',
    'echo "Instance marker: $MARKER"',
    'echo "configuration.json of the export, beside this package\'s, to compare:"',
    'unzip -p "$BACKUP" configuration.json 2>/dev/null | jq -c . || true',
    'jq -c . "$WORK/content/configuration.json"',
    ...(dash
      ? [
          '# The content import files a dashboard under its owner: the user this runs as.',
          `curl -sS -f "https://\${VCFOPS_HOST}/suite-api/api/auth/currentuser" -H "${authHeader(PLATFORM)}" -H "Accept: application/json" > "$WORK/me.json"`,
          'OWNER_ID=$(jq -r \'.id // empty\' "$WORK/me.json")',
          'OWNER_NAME=$(jq -r \'.username // .userName // empty\' "$WORK/me.json")',
          '[[ -n "$OWNER_ID" ]] || { echo "GET /suite-api/api/auth/currentuser gave no id. VERIFY the call on your release." >&2; exit 1; }',
          'file_dashboard',
        ]
      : []),
    '',
    'mkdir -p "$WORK/existing"',
    'unzip -q -o "$BACKUP" -d "$WORK/existing"',
    '# Content zips hold zips; open every level.',
    'for _ in 1 2 3; do',
    '  while IFS= read -r -d "" z; do',
    '    mkdir -p "$z.d" && unzip -q -o "$z" -d "$z.d" && mv "$z" "$z.opened"',
    '  done < <(find "$WORK/existing" -name "*.zip" -print0)',
    'done',
    '# Dashboards are stored as zips without an extension, under dashboards/.',
    'while IFS= read -r -d "" z; do unzip -q -o "$z" -d "$z.d" 2>/dev/null || true; done < <(find "$WORK/existing" -path "*/dashboards/*" -type f -print0)',
    `NEEDLES=(${opts.needles.map((n) => `'${sq(n)}'`).join(' ')})`,
    'EXISTS=0',
    'for needle in "${NEEDLES[@]}"; do',
    '  if grep -rqF -- "$needle" "$WORK/existing"; then echo "Already in VCF Operations: $needle"; EXISTS=1; fi',
    'done',
    'if (( EXISTS && ! OVERWRITE )); then',
    '  echo "Refusing to replace existing content. Compare it with the backup ($BACKUP); to replace it, re-run with --overwrite." >&2',
    '  exit 1',
    'fi',
    '',
    '# 3. Import, and follow this import by its id.',
    'build',
    'FORCE=false',
    '(( OVERWRITE )) && FORCE=true',
    `RESP=$(curl -sS -f -X POST "$API/import?force=\${FORCE}" -H "${authHeader(PLATFORM)}" -H "Accept: application/json" -F "contentFile=@$OUT;type=application/zip")`,
    'IMPORT_ID=$(jq -r \'.id // empty\' <<<"$RESP")',
    '[[ -n "$IMPORT_ID" ]] || { echo "The import was accepted without an id, so its result cannot be told from an earlier import. Check Content Management in the interface." >&2; exit 1; }',
    'echo "import ${IMPORT_ID} (force=${FORCE})"',
    'STATE=""',
    'for _ in $(seq 1 60); do',
    '  sleep 10',
    '  code=$(last_op import "$WORK/import.json")',
    '  [[ "$code" == 200 ]] || { echo "$(date +%T) status HTTP $code" >&2; continue; }',
    '  [[ "$(jq -r \'.id // empty\' "$WORK/import.json")" == "$IMPORT_ID" ]] || continue',
    '  STATE=$(jq -r \'.state // "UNKNOWN"\' "$WORK/import.json")',
    '  echo "$(date +%T) ${STATE}"',
    '  case "$STATE" in FINISHED|FAILED) break ;; esac',
    'done',
    '[[ -s "$WORK/import.json" ]] && jq \'{id, state, errorCode, errorMessages, operationSummaries}\' "$WORK/import.json"',
    'if [[ "$STATE" != FINISHED ]]; then',
    '  echo "Import ${IMPORT_ID} did not finish: ${STATE:-no status for it after 10 minutes}. The backup is $BACKUP." >&2',
    '  exit 1',
    'fi',
    'read -r FAILED SKIPPED IMPORTED ERRORS < <(jq -r \'[([.operationSummaries[]? | .failed // 0] | add // 0), ([.operationSummaries[]? | .skipped // 0] | add // 0), ([.operationSummaries[]? | .imported // 0] | add // 0), ([.errorMessages[]?] | length)] | @tsv\' "$WORK/import.json")',
    'if (( FAILED > 0 || ERRORS > 0 )); then echo "Import ${IMPORT_ID} finished with ${FAILED} failed item(s) and ${ERRORS} error message(s)." >&2; exit 1; fi',
    'if (( SKIPPED > 0 )); then echo "Import ${IMPORT_ID} skipped ${SKIPPED} item(s): existing content was left in place." >&2; exit 1; fi',
    'if (( IMPORTED == 0 )); then echo "Import ${IMPORT_ID} finished but reports nothing imported. VERIFY operationSummaries on your release, and check in the interface." >&2; exit 1; fi',
    'echo "Imported ${IMPORTED} item(s). Backup of what was there before: $BACKUP"',
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Policies: merge into an export, never import a fragment
// ---------------------------------------------------------------------------

/**
 * merge-policy.sh: export the policy, merge the `<Alerts>` overrides from
 * OVERRIDES into its XML, write import/policy-merged.zip, and — unless --dry-run —
 * import it with POST /api/policies/import?forceImport=true (multipart
 * `policy`). The export it starts from is kept as the undo.
 */
export function policyMergeScript(overridesFile        , policyName        )         {
  return [
    '#!/usr/bin/env bash',
    `# Merge the alert settings in ${overridesFile} into an export of "${policyName}", and`,
    '# import the result.',
    '#',
    '# A policy XML holds a policy\'s overrides of its parent. Importing only the few',
    '# lines this change is about would replace every other override the policy has,',
    '# so this starts from an export of the policy as it is now, changes only the',
    '# <Alert> elements named in the overrides file, and imports that.',
    '#',
    '# It exports, merges, writes import/policy-merged.zip, shows what changed, and',
    '# then POSTs the merged zip (with --dry-run it stops before the POST) to',
    '# /suite-api/api/policies/import?forceImport=true. The export is kept beside this',
    '# script as policy-before-<time>.zip: re-importing it the same way is the undo.',
    'set -euo pipefail',
    '',
    ...authPreamble(PLATFORM),
    ': "${POLICY_ID:?set POLICY_ID — GET /suite-api/api/policies and match by name}"',
    'for tool in curl python3; do command -v "$tool" >/dev/null || { echo "$tool is required" >&2; exit 2; }; done',
    'EXECUTE=1',
    '[[ "${1:-}" == "--dry-run" ]] && EXECUTE=0',
    'HERE=$(cd "$(dirname "$0")" && pwd)',
    'mkdir -p "$HERE/import"',
    '',
    'BEFORE="$HERE/policy-before-$(date +%Y%m%d-%H%M%S).zip"',
    `curl -sS -f "https://\${VCFOPS_HOST}/suite-api/api/policies/export?id=\${POLICY_ID}" -H "${authHeader(PLATFORM)}" -H "Accept: application/zip" -o "$BEFORE"`,
    'echo "Exported the policy as it is now: $BEFORE (the undo)"',
    '',
    `python3 - "$BEFORE" "$HERE/${overridesFile}" "$HERE/import/policy-merged.zip" <<'PY'`,
    'import re, sys, zipfile, xml.etree.ElementTree as ET',
    'src, overrides, out = sys.argv[1:4]',
    'with zipfile.ZipFile(src) as z:',
    '    names = z.namelist()',
    '    xmls = [n for n in names if n.lower().endswith(".xml")]',
    '    if len(xmls) != 1:',
    '        sys.exit("expected one XML file in the policy export, found %r" % xmls)',
    '    name = xmls[0]',
    '    raw = z.read(name)',
    '    others = {n: z.read(n) for n in names if n != name}',
    '# Keep any namespace prefixes the export uses, so the re-import reads the same.',
    'for prefix, uri in re.findall(r\'xmlns(?::([A-Za-z_][\\w.-]*))?="([^"]+)"\', raw.decode("utf-8")):',
    '    ET.register_namespace(prefix or "", uri)',
    'root = ET.fromstring(raw)',
    'def child(parent, name, attrs):',
    '    ns = parent.tag[: parent.tag.index("}") + 1] if parent.tag.startswith("{") else ""',
    '    return ET.SubElement(parent, ns + name, attrs)',
    'policies = root.findall(".//{*}Policy")',
    'if len(policies) != 1:',
    '    sys.exit("expected exactly one <Policy> in the export, found %d; export one policy by its id" % len(policies))',
    'policy = policies[0]',
    'package = policy.find("{*}PackageSettings")',
    'if package is None:',
    '    package = child(policy, "PackageSettings", {})',
    'changes = 0',
    'for block in ET.parse(overrides).getroot().iter("Alerts"):',
    '    ak, rk = block.get("adapterKind"), block.get("resourceKind")',
    '    target = None',
    '    for candidate in package.findall("{*}Alerts"):',
    '        if candidate.get("adapterKind") == ak and candidate.get("resourceKind") == rk:',
    '            target = candidate',
    '            break',
    '    if target is None:',
    '        target = child(package, "Alerts", {"adapterKind": ak, "resourceKind": rk})',
    '    for alert in block.findall("Alert"):',
    '        alert_id = alert.get("id") or ""',
    '        if not alert_id or "REQUIRED" in alert_id:',
    '            sys.exit("an <Alert> in the overrides file has no alert definition id yet")',
    '        existing = None',
    '        for candidate in target.findall("{*}Alert"):',
    '            if candidate.get("id") == alert_id:',
    '                existing = candidate',
    '                break',
    '        before = dict(existing.attrib) if existing is not None else None',
    '        if existing is None:',
    '            existing = child(target, "Alert", {"id": alert_id})',
    '        for key, value in alert.attrib.items():',
    '            existing.set(key, value)',
    '        if before != dict(existing.attrib):',
    '            changes += 1',
    '            print("%s/%s %s: %s -> %s" % (ak, rk, alert_id, before, dict(existing.attrib)))',
    'data = ET.tostring(root, encoding="utf-8", xml_declaration=True)',
    'with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:',
    '    z.writestr(name, data)',
    '    for n, b in others.items():',
    '        z.writestr(n, b)',
    'print("%d alert setting(s) changed; wrote %s" % (changes, out))',
    'PY',
    '',
    'if (( ! EXECUTE )); then',
    '  echo "DRY RUN: would POST import/policy-merged.zip to https://${VCFOPS_HOST}/suite-api/api/policies/import?forceImport=true"',
    '  echo "Dry run: nothing was changed. Run it without --dry-run to apply, or import import/policy-merged.zip under Policies → Import yourself."',
    '  exit 0',
    'fi',
    `curl -sS -f -X POST "https://\${VCFOPS_HOST}/suite-api/api/policies/import?forceImport=true" -H "${authHeader(PLATFORM)}" -H "Accept: application/json" -F "policy=@$HERE/import/policy-merged.zip;type=application/zip"`,
    'echo',
    'echo "Imported. Undo: POST $BEFORE to the same endpoint the same way."',
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// IMPORT.md
// ---------------------------------------------------------------------------

                             
                                                                                                 
                           
                           
                                    
                                           
                                  
                                                 
                                      
 

/** The sources the formats were established from, cited in every IMPORT.md that imports content. */
export const FORMAT_SOURCES                    = [
  'Broadcom TechDocs, VCF Operations 9.0: "Importing Content" (Content Management) and "Exporting and Importing a Super Metric".',
  'Real exports: github.com/notoriousbdg (VMware, 8.x: alert XML, CustomGroups.json, Supermetrics.json, Views.zip, Dashboard.zip) and github.com/sentania-labs/vcf-content-factory-bundles (VCF Operations 9: AlertContent.xml, supermetric.json, Views.zip, Reports.zip, Dashboard.zip, content-zip installer).',
  'VCF Operations API reference: /api/content/operations/{export,import}, /api/policies/{export,import}.',
];

export function importMd(opts                                                                                                                                             )         {
  const lines = [`# Importing: ${opts.title}`, ''];
  lines.push(...(opts.intro ?? ['Each step says which file goes where, in the order they depend on each other. Menu paths are VCF Operations 9.1.']), '');
  opts.steps.forEach((step, index) => {
    lines.push(`## ${index + 1}. ${step.heading}`, '');
    if (step.files.length > 0) lines.push(`Files: ${step.files.map((file) => `\`${file}\``).join(', ')}`, '');
    for (const line of step.how) lines.push(`- ${line}`);
    for (const line of step.verify ?? []) lines.push(`- VERIFY: ${line}`);
    lines.push('');
  });
  if (opts.sources && opts.sources.length > 0) {
    lines.push('## Where these formats come from', '');
    for (const source of opts.sources) lines.push(`- ${source}`);
    lines.push('');
  }
  return lines.join('\n');
}

/** IMPORT.md for an output that imports nothing: what to do with it instead. */
export function nothingToImportMd(title        , instead                   )         {
  return importMd({
    title,
    intro: ['Nothing in this output is a file VCF Operations imports: it is scripts and notes run from a host of your own, against the API. What to do with each:'],
    steps: [{ heading: 'Put it in place', files: [], how: instead }],
  });
}

/** The content-management step every content package gets. */
export function contentStep(contentType        , script = 'import-content.sh')             {
  return {
    heading: 'Or: everything at once, through Content Management',
    files: [CONTENT_ZIP, script],
    how: [
      `By API: \`./${script} --dry-run\` builds the package and stops; \`./${script}\` exports the existing ${contentType} content as a backup, copies the instance's own \`<number>L.v1\` marker from it into the package, and imports it (POST /suite-api/api/content/operations/import, force=false unless \`--overwrite\`).`,
      'In the interface: Administration → Control Panel → Content Management → Import, with "Skip" or "Overwrite existing content".',
    ],
    verify: [
      `the package as generated has no \`<number>L.v1\` marker — its name is particular to each instance, and the importer is reported to reject a package without its own. ${script} adds it; uploading ${CONTENT_ZIP} in the interface as it stands is not confirmed to work. To upload by hand, take the marker file from a Content Management export of the same instance and add it to the zip's root first.`,
      'configuration.json keys other than superMetrics, views, reports, dashboards and type are not confirmed; the script prints the export\'s beside the package\'s to compare.',
    ],
  };
}

/** What a file that VCF Operations does not import is for, from its name. */
function roleOf(file        )         {
  if (file === 'crontab.txt') return 'a line for the crontab of the account that runs the script. No secret is in it; the script logs in from its password file. Its lines are written active.';
  if (/\.sh$/.test(file)) return 'a script run from a host of your own against the API (curl and jq). Its header says what it needs; a script that changes anything applies when run; --dry-run previews.';
  if (/\.ps1$/.test(file)) return 'the same, for PowerShell 7.';
  if (/\.promql$/.test(file)) return 'queries to paste into the metrics explorer, one per block.';
  if (/\.csv$/.test(file)) return 'values to type in, or to keep as the record of what was set.';
  if (/\.json$/.test(file)) return 'the values a script beside it reads and sends.';
  return 'for a person to read and follow.';
}

/** IMPORT.md for an output of scripts and notes: one line per file saying what it is for. */
export function scriptsImportMd(title        , files                   , extra                    = [])         {
  return nothingToImportMd(title, [...files.filter((file) => file !== 'README.md' && file !== 'IMPORT.md').map((file) => `\`${file}\` — ${roleOf(file)}`), ...extra]);
}

/**
 * A blueprint whose output imports nothing, given an IMPORT.md that lists its
 * files and what each is for — unless it already writes its own.
 */
export function withScriptsImportMd(blueprint                     )                      {
  const automation = (values                                                  , name        )             => {
    const made = blueprint.automation(values, name);
    if (made.files['IMPORT.md']) return made;
    return { ...made, files: { ...made.files, 'IMPORT.md': scriptsImportMd(made.title, Object.keys(made.files)) } };
  };
  return { ...blueprint, automation, build: (values, name) => automationFiles(automation(values, name), name) };
}
