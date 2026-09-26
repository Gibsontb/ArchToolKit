/**
 * VCF Operations 9.1: cost and capacity.
 *
 * VCF Operations 9.1 carries a finished cost engine and a capacity engine, and
 * most estates run both on their defaults: MSRP server prices nobody checked,
 * no facilities cost, a CPU:memory split the engine chose, and a capacity
 * policy nobody knows the buffer of. The numbers still look authoritative,
 * which is the problem — a showback bill or a "time remaining" figure is read
 * by people who cannot tell the default from a decision.
 *
 * These blueprints write the decisions down and apply them: pricing policies,
 * report schedules and policy sections through the documented API; cost
 * drivers, Automation Central jobs and custom profiles through the
 * /suite-api/internal endpoints (VERIFY), placing each value by matching names
 * in what the API returns, reading everything back, and stopping with the
 * exact interface steps when an endpoint is not there. Where no API exists at
 * all (what-if, bills, pricing assignment, the Reclaim tag exclusion) they say
 * so plainly and give the shortest manual steps.
 *
 * 9.1 names: cost drivers now cover clusters, hosts and datacenters as well as
 * VMs; the server hardware driver has a spreadsheet-style editor; CPU:memory
 * cost ratios are customisable; the Reclaim page deletes orphaned disks and
 * shows one VM under several recommendations at once; tag, age and appliance
 * exclusions apply to Reclaim and Rightsize recommendations (tag exclusions to
 * Automation Central too, per Broadcom's 9.1 guidance — verify); bills
 * go out as PDF by email; VKS is costed down to nodes, clusters and vSphere
 * Namespaces.
 */

import { bool, num, str, type BlueprintValues } from '../../kit/blueprint.ts';
import { error, info, warning, type Finding } from '../../core/findings.ts';
import { automationBlueprint, type AutomationBlueprint } from '../from-automation.ts';
import { listOf, slugOf, type Automation } from '../automation.ts';
import { authHeader, authPreamble, readScript, scheduledEnv } from '../apply.ts';
import { importMd, withScriptsImportMd } from '../vcfops-import.ts';

const PLATFORM = 'vcf-operations' as const;
const SRC = 'ArchToolKit';
const HDR = authHeader(PLATFORM);

const WEEKDAYS: Readonly<Record<string, number>> = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };

function cronOf(when: string): string {
  const match = /^\s*([a-z]+)\s+(\d{1,2}):(\d{2})\s*$/i.exec(when);
  const day = match ? WEEKDAYS[match[1]!.toLowerCase()] : undefined;
  if (!match || day === undefined) return '<REQUIRED: minute hour * * weekday>';
  return `${Number(match[3])} ${Number(match[2])} * * ${day}`;
}

/** A day earlier, for a check that has to run before the job it checks. */
function dayBefore(when: string): string {
  const match = /^\s*([a-z]+)\s+(\d{1,2}):(\d{2})\s*$/i.exec(when);
  const day = match ? WEEKDAYS[match[1]!.toLowerCase()] : undefined;
  if (!match || day === undefined) return '<REQUIRED: minute hour * * weekday>';
  return `${Number(match[3])} ${Number(match[2])} * * ${(day + 6) % 7}`;
}

const money = (value: number): string => (Math.round(value * 100) / 100).toFixed(2);

/**
 * The lines that find every cost metric a resource reports, without trusting a
 * key name from documentation: cost keys have moved between releases, so the
 * script asks one resource which of its stat keys are cost keys and reads those.
 */
function costKeyDiscovery(resourceVar: string, pattern: string): string[] {
  return [
    `keys=$(get "/suite-api/api/resources/\${${resourceVar}}/statkeys" | jq -c --arg re '${pattern}' '[.["stat-key"][]?.key | select(test($re; "i"))] | unique')`,
    'if [[ "$(jq length <<<"$keys")" == 0 ]]; then',
    '  echo "No cost metrics on this object. Either the cost engine has not run (it starts once a currency is set, then runs daily) or this release names them differently." >&2',
    '  exit 1',
    'fi',
    'printf \'%s\\n\' "$keys" >"$WORK/keys.json"',
  ];
}

/** POST for a read-only query endpoint, inside a readScript body. */
const POST_QUERY = [
  'post() {',
  `  curl -sS -f -X POST "https://\${VCFOPS_HOST}$1" -H "${HDR}" -H "Accept: application/json" -H "Content-Type: application/json" --data @-`,
  '}',
  '',
];

/** latest-stats response → {resourceId: {statKey: value}} */
const LATEST_TO_MAP = `[.values[]? | {(.resourceId): ([."stat-list".stat[]? | {(.statKey.key): ((.data // []) | last)}] | add // {})}] | add // {}`;

/** The variable holding the private auth header file authPreamble writes, so a script's own EXIT trap can remove it too. */
const AUTH_FILE_VAR = /^@\$\{(\w+)\}$/.exec(HDR)?.[1];

/**
 * Lists and stat queries sized by the estate go through files, never through
 * `jq --arg/--argjson`: an argument list tops out around 2 MB, which a group of
 * a few thousand VMs passes, and the script then dies with "Argument list too
 * long" (exit 126) instead of the check it was written to make. Lists are paged
 * and stat queries sent 500 resources at a time.
 */
const LARGE_DATA = [
  'WORK=$(umask 077; mktemp -d)',
  `trap 'rm -rf "$WORK"${AUTH_FILE_VAR ? `; rm -f "$${AUTH_FILE_VAR}"` : ''}' EXIT`,
  '',
  '# Every page of a suite-api resource list, as a JSON array in a file: get_all PATH OUT',
  'get_all() {',
  '  local path="$1" out="$2" page=0 total n sep="?"',
  '  [[ "$path" == *"?"* ]] && sep="&"',
  '  : >"$out.lines"',
  '  while :; do',
  '    get "${path}${sep}page=${page}&pageSize=1000" >"$out.page"',
  '    jq -c \'.resourceList[]?\' "$out.page" >>"$out.lines"',
  '    total=$(jq \'.pageInfo.totalCount // 0\' "$out.page")',
  '    n=$(jq \'.resourceList // [] | length\' "$out.page")',
  '    page=$((page + 1))',
  '    (( n > 0 && $(wc -l <"$out.lines") < total )) || break',
  '  done',
  '  jq -s -c . "$out.lines" >"$out"',
  '  rm -f "$out.page" "$out.lines"',
  '}',
  '',
  '# Latest value of each stat key for each resource: latest_map IDS.json KEYS.json OUT.json → {id: {key: value}}',
  'latest_map() {',
  '  local ids="$1" keys="$2" out="$3" n i',
  '  n=$(jq length "$ids")',
  '  echo \'{}\' >"$out"',
  '  for (( i = 0; i < n; i += 500 )); do',
  '    jq -n -c --slurpfile r "$ids" --slurpfile k "$keys" --argjson i "$i" \'{resourceId: $r[0][$i:$i + 500], statKey: $k[0], maxSamples: 1}\' |',
  `      post /suite-api/api/resources/stats/latest/query | jq -c '${LATEST_TO_MAP}' >"$out.part"`,
  '    jq -s -c \'.[0] + .[1]\' "$out" "$out.part" >"$out.new" && mv "$out.new" "$out"',
  '  done',
  '  rm -f "$out.part"',
  '}',
  '',
];

/** The currencies VCF Operations offers for its cost engine (a closed set: set once, never converted). */
const CURRENCIES = [
  { value: 'USD', label: 'US dollar' },
  { value: 'EUR', label: 'Euro' },
  { value: 'GBP', label: 'Pound sterling' },
  { value: 'AUD', label: 'Australian dollar' },
  { value: 'CAD', label: 'Canadian dollar' },
  { value: 'NZD', label: 'New Zealand dollar' },
  { value: 'JPY', label: 'Japanese yen' },
  { value: 'CNY', label: 'Chinese yuan' },
  { value: 'HKD', label: 'Hong Kong dollar' },
  { value: 'SGD', label: 'Singapore dollar' },
  { value: 'INR', label: 'Indian rupee' },
  { value: 'KRW', label: 'South Korean won' },
  { value: 'CHF', label: 'Swiss franc' },
  { value: 'SEK', label: 'Swedish krona' },
  { value: 'NOK', label: 'Norwegian krone' },
  { value: 'DKK', label: 'Danish krone' },
  { value: 'PLN', label: 'Polish złoty' },
  { value: 'ZAR', label: 'South African rand' },
  { value: 'BRL', label: 'Brazilian real' },
  { value: 'MXN', label: 'Mexican peso' },
  { value: 'AED', label: 'UAE dirham' },
] as const;

/** " | " rows, blank and # lines skipped, each cell trimmed. */
function rowsOf(text: string): string[][] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => line.split('|').map((cell) => cell.trim()));
}

/** A number typed into a grid cell (thousands commas allowed), or the fallback when it is not one. */
const numOr = (text: string | undefined, fallback: number): number => {
  const cleaned = String(text ?? '').trim().replace(/,/g, '');
  return /^[-+]?(\d+\.?\d*|\.\d+)$/.test(cleaned) ? Number(cleaned) : fallback;
};

/**
 * The header a call to a VCF Operations /suite-api/internal/ endpoint needs.
 * Internal endpoints work and are supported only as far as the release says;
 * every script that uses one says so and stops cleanly when it is not there.
 */
const INTERNAL_HDR = 'X-Ops-API-use-unsupported: true';

/** api METHOD PATH [curl args…] — any suite-api call, inside a script that ran authPreamble. */
const API_FN = [
  'api() {',
  '  local method="$1" path="$2"; shift 2',
  `  curl -sS -f -X "$method" "https://\${VCFOPS_HOST}\${path}" -H "${HDR}" -H "Accept: application/json" -H "${INTERNAL_HDR}" "$@"`,
  '}',
  '# probe PATH: the HTTP status of a GET, without failing the script.',
  'probe() {',
  `  curl -sS -o /dev/null -w "%{http_code}" "https://\${VCFOPS_HOST}$1" -H "${HDR}" -H "Accept: application/json" -H "${INTERNAL_HDR}" || echo 000`,
  '}',
  '',
];

/**
 * set_global KEY_REGEX VALUE LABEL — one VCF Operations global setting, found by
 * pattern rather than by an assumed key name, set only when it differs.
 * VERIFY: GET/PUT /suite-api/api/deployment/config/globalsettings is the 8.x
 * shape (keyValues[].key / values[]); the script refuses rather than guess.
 */
const GLOBAL_SETTING_FN = [
  'GLOBALS_PATH="${GLOBALS_PATH:-/suite-api/api/deployment/config/globalsettings}"',
  'set_global() {',
  '  local re="$1" value="$2" label="$3" keys key current',
  '  api GET "$GLOBALS_PATH" >"$WORK/globals.json"',
  '  keys=$(jq -r --arg re "$re" \'[(.keyValues // .globalSettings // .settings // [])[]? | (.key // .name) | strings | select(test($re; "i"))] | unique | .[]\' "$WORK/globals.json")',
  '  if [[ $(grep -c . <<<"$keys") != 1 ]]; then',
  '    echo "Global setting for ${label}: expected exactly one key matching /${re}/, found: ${keys:-none}. All keys:" >&2',
  '    jq -r \'[(.keyValues // .globalSettings // .settings // [])[]? | (.key // .name)] | .[]\' "$WORK/globals.json" >&2',
  '    return 3',
  '  fi',
  '  key="$keys"',
  '  current=$(jq -r --arg k "$key" \'[(.keyValues // .globalSettings // .settings // [])[]? | select((.key // .name) == $k) | ((.values // [])[0] // .value // "")][0] // ""\' "$WORK/globals.json")',
  '  if [[ "$current" == "$value" ]]; then echo "${label}: already ${value} (${key})."; return 0; fi',
  '  printf \'%s\\t%s\\t%s\\n\' "$key" "$current" "$value" >>"$WORK/globals-changed.tsv"',
  '  if (( ! EXECUTE )); then echo "DRY RUN: would set ${key} from \\"${current}\\" to \\"${value}\\" (${label})."; return 0; fi',
  '  api PUT "${GLOBALS_PATH}/$(jq -rn --arg k "$key" \'$k|@uri\')/$(jq -rn --arg v "$value" \'$v|@uri\')" >/dev/null',
  '  echo "${label}: ${key} set to ${value} (was \\"${current}\\")."',
  '}',
  '',
];

/** find_policy NAME → POLICY_ID, unless POLICY_ID is already set. Exactly one match or it stops. */
const FIND_POLICY_FN = [
  'find_policy() {',
  '  [[ -n "${POLICY_ID:-}" ]] && return 0',
  '  local ids',
  '  ids=$(api GET /suite-api/api/policies | jq -r --arg n "$1" \'[.. | objects | select(.name? == $n) | (.id // .key // empty)] | unique | .[]\')',
  '  if [[ $(grep -c . <<<"$ids") != 1 ]]; then echo "Expected exactly one policy named \\"$1\\", found: ${ids:-none}. Set POLICY_ID." >&2; exit 2; fi',
  '  POLICY_ID="$ids"',
  '}',
  '',
];

/**
 * A policy section merge: export the policy, merge an overrides XML of any
 * <PackageSettings> children into it (matched by tag and adapterKind,
 * resourceKind, id, key, name, type), import, export again and check every
 * value stuck. If one did not — the release ignored an element it does not
 * know — the export taken first is imported back and the script exits 1.
 * An element whose tag the export does not have anywhere stops the run before
 * anything is imported, unless ALLOW_NEW=1: that is how a guessed element name
 * is caught instead of silently dropped.
 */
function policySectionMergeScript(overridesFile: string, policyName: string, what: string): string {
  return [
    '#!/usr/bin/env bash',
    `# Apply the ${what} in ${overridesFile} to the policy "${policyName}".`,
    '#',
    '# Export → merge → import → export again and check → put the first export back',
    '# if anything did not stick. Only the elements in the overrides file change;',
    '# every other override the policy has is kept, because the merge starts from',
    '# the policy as it is now. Applies when run; --dry-run stops before the import.',
    'set -euo pipefail',
    '',
    ...authPreamble(PLATFORM),
    'for tool in curl jq python3; do command -v "$tool" >/dev/null || { echo "$tool is required" >&2; exit 2; }; done',
    'EXECUTE=1',
    '[[ "${1:-}" == "--dry-run" ]] && EXECUTE=0',
    'HERE=$(cd "$(dirname "$0")" && pwd)',
    'WORK=$(umask 077; mktemp -d)',
    `trap 'rm -rf "$WORK"${AUTH_FILE_VAR ? `; rm -f "$${AUTH_FILE_VAR}"` : ''}' EXIT`,
    ...API_FN,
    ...FIND_POLICY_FN,
    `find_policy ${JSON.stringify(policyName)}`,
    'export_policy() { curl -sS -f "https://${VCFOPS_HOST}/suite-api/api/policies/export?id=${POLICY_ID}" -H "' + HDR + '" -H "Accept: application/zip" -o "$1"; [[ -s "$1" ]]; }',
    'import_policy() { curl -sS -f -X POST "https://${VCFOPS_HOST}/suite-api/api/policies/import?forceImport=true" -H "' + HDR + '" -H "Accept: application/json" -F "policy=@$1;type=application/zip" >/dev/null; }',
    '',
    'BEFORE="$HERE/policy-before-$(date +%Y%m%d-%H%M%S).zip"',
    'export_policy "$BEFORE"',
    'echo "Exported the policy as it is now: $BEFORE (the undo)"',
    '',
    'cat >"$WORK/merge.py" <<\'PY\'',
    'import re, sys, zipfile, xml.etree.ElementTree as ET',
    'mode, src, overrides = sys.argv[1:4]',
    'out = sys.argv[4] if len(sys.argv) > 4 else None',
    'allow_new = len(sys.argv) > 5 and sys.argv[5] == "1"',
    'KEYS = ("adapterKind", "resourceKind", "id", "key", "name", "type")',
    'def local(tag): return tag.split("}")[-1]',
    'with zipfile.ZipFile(src) as z:',
    '    names = z.namelist()',
    '    xmls = [n for n in names if n.lower().endswith(".xml")]',
    '    if len(xmls) != 1: sys.exit("expected one XML file in the policy export, found %r" % xmls)',
    '    name = xmls[0]; raw = z.read(name); others = {n: z.read(n) for n in names if n != name}',
    'for prefix, uri in re.findall(r\'xmlns(?::([A-Za-z_][\\w.-]*))?="([^"]+)"\', raw.decode("utf-8")):',
    '    ET.register_namespace(prefix or "", uri)',
    'root = ET.fromstring(raw)',
    'policies = root.findall(".//{*}Policy")',
    'if len(policies) != 1: sys.exit("expected exactly one <Policy> in the export, found %d" % len(policies))',
    'package = policies[0].find("{*}PackageSettings")',
    'if package is None:',
    '    ns = policies[0].tag[: policies[0].tag.index("}") + 1] if policies[0].tag.startswith("{") else ""',
    '    package = ET.SubElement(policies[0], ns + "PackageSettings", {})',
    'known = {local(e.tag) for e in root.iter()}',
    'had = sorted({local(c.tag) for c in package})',
    'def find(parent, o):',
    '    for c in parent:',
    '        if local(c.tag) == local(o.tag) and all(c.get(k) == o.get(k) for k in KEYS if o.get(k) is not None):',
    '            return c',
    '    return None',
    'changes, missing, new = [], [], []',
    'def walk(parent, o, path):',
    '    here = "%s/%s%s" % (path, local(o.tag), "".join("[@%s=%s]" % (k, o.get(k)) for k in KEYS if o.get(k)))',
    '    t = find(parent, o) if parent is not None else None',
    '    if mode == "check":',
    '        for k, v in o.attrib.items():',
    '            if t is None or t.get(k) != v: missing.append("%s @%s=%s (now %s)" % (here, k, v, None if t is None else t.get(k)))',
    '    else:',
    '        if t is None:',
    '            if local(o.tag) not in known: new.append(here)',
    '            ns = parent.tag[: parent.tag.index("}") + 1] if parent.tag.startswith("{") else ""',
    '            t = ET.SubElement(parent, ns + local(o.tag), {k: o.get(k) for k in KEYS if o.get(k) is not None})',
    '        for k, v in o.attrib.items():',
    '            if t.get(k) != v: changes.append("%s @%s: %s -> %s" % (here, k, t.get(k), v)); t.set(k, v)',
    '    for c in o: walk(t, c, here)',
    'ov = ET.parse(overrides).getroot()',
    'ovpkg = ov if local(ov.tag) == "PackageSettings" else ov.find(".//PackageSettings")',
    'if ovpkg is None: sys.exit("the overrides file has no <PackageSettings>")',
    'for o in ovpkg: walk(package, o, "PackageSettings")',
    'if mode == "check":',
    '    for m in missing: print("DID NOT STICK: " + m)',
    '    sys.exit(1 if missing else 0)',
    'for c in changes: print(c)',
    'if new and not allow_new:',
    '    print("These elements are not in the export anywhere, so their names are unconfirmed on this release:", file=sys.stderr)',
    '    for n in new: print("  " + n, file=sys.stderr)',
    '    print("Tags the export has under PackageSettings: " + (", ".join(had) or "none"), file=sys.stderr)',
    '    print("Set one of these values once in the policy editor and run again (the export then carries the element), rename it in the overrides file, or ALLOW_NEW=1 to import it anyway: the check after the import still catches a dropped value.", file=sys.stderr)',
    '    sys.exit(3)',
    'with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:',
    '    z.writestr(name, ET.tostring(root, encoding="utf-8", xml_declaration=True))',
    '    for n, b in others.items(): z.writestr(n, b)',
    'print("%d value(s) to change; wrote %s" % (len(changes), out))',
    'PY',
    '',
    'mkdir -p "$HERE/import"',
    `python3 "$WORK/merge.py" merge "$BEFORE" "$HERE/${overridesFile}" "$HERE/import/policy-merged.zip" "\${ALLOW_NEW:-0}"`,
    'if (( ! EXECUTE )); then',
    '  echo "DRY RUN: would POST import/policy-merged.zip to https://${VCFOPS_HOST}/suite-api/api/policies/import?forceImport=true"',
    '  echo "Dry run: nothing was changed. Run it without --dry-run to apply."',
    '  exit 0',
    'fi',
    'import_policy "$HERE/import/policy-merged.zip"',
    'AFTER="$WORK/after.zip"',
    'export_policy "$AFTER"',
    `if ! python3 "$WORK/merge.py" check "$AFTER" "$HERE/${overridesFile}"; then`,
    '  echo "The release did not keep every value above. Putting the policy back as it was." >&2',
    '  import_policy "$BEFORE"',
    '  exit 1',
    'fi',
    `echo "Applied and read back: every value in ${overridesFile} is in the policy. Undo: POST $BEFORE to /suite-api/api/policies/import?forceImport=true (multipart field policy)."`,
    '',
  ].join('\n');
}

export const VCF_OPS_COST: readonly AutomationBlueprint[] = [
  // -------------------------------------------------------------------------
  automationBlueprint({
    id: 'vcfops_cost_drivers',
    platform: PLATFORM,
    label: 'Cost drivers and the CPU:memory cost ratio, per datacenter',
    group: 'Cost',
    description:
      'The numbers every VM cost is derived from: server hardware (bought and depreciated, or leased), licences, maintenance, labour, network, facilities and storage, per datacenter — plus the 9.1 customisable ratio that splits a host’s cost between CPU and memory, the 9.1 additional costs on clusters, hosts and datacenters (fixed, by tag or by metric), and storage cost per datastore or storage policy. Applied: the currency is set, the cost drivers are read, changed where they differ and written back (PUT), then read again to prove every value stuck — with a check that snapshots the cost engine’s output before the change and fails if a cluster’s cost swings further than you said it should.',
    inputs: [
      { id: 'datacenters', label: 'Datacenters', control: 'text', default: 'DC-North, DC-South', hint: 'As VCF Operations names them. The same values are written for each; edit cost-drivers.json where they differ' },
      { id: 'currency', label: 'Currency', control: 'select', options: CURRENCIES, default: 'USD', hint: 'Set once, before the first calculation. Changing it later is not a conversion, so the apply script refuses to change a currency already set' },
      { id: 'hosts', label: 'Hosts per datacenter', control: 'number', default: 8, min: 1, max: 2000 },
      { id: 'ownership', label: 'Server hardware is', control: 'select', options: [{ value: 'purchase', label: 'Bought, and depreciated' }, { value: 'lease', label: 'Leased' }], default: 'purchase' },
      { id: 'server_cost', label: 'Price paid per server', control: 'number', default: 28000, min: 0, max: 2000000, showWhen: { input: 'ownership', equals: ['purchase'] }, hint: 'What you paid, not list price. The engine’s default is an MSRP estimate' },
      { id: 'depreciation_years', label: 'Depreciate over (years)', control: 'number', default: 5, min: 1, max: 10, showWhen: { input: 'ownership', equals: ['purchase'] } },
      { id: 'depreciation_method', label: 'Depreciation method', control: 'select', options: [{ value: 'straight', label: 'Straight line' }, { value: 'double', label: 'Max of double declining or straight line' }], default: 'straight', showWhen: { input: 'ownership', equals: ['purchase'] } },
      { id: 'lease_monthly', label: 'Lease per server per month', control: 'number', default: 700, min: 0, max: 100000, showWhen: { input: 'ownership', equals: ['lease'] } },
      { id: 'cores_per_host', label: 'Licensed cores per host', control: 'number', default: 64, min: 1, max: 1024 },
      { id: 'licence_core_year', label: 'Licence per core per year', control: 'number', default: 350, min: 0, max: 100000, hint: 'Your contracted price for the VCF subscription plus any guest OS licensing you want costed per host' },
      { id: 'maintenance_pct', label: 'Hardware maintenance (% of price per year)', control: 'number', default: 10, min: 0, max: 50, showWhen: { input: 'ownership', equals: ['purchase'] } },
      { id: 'labour_host_month', label: 'Labour per host per month', control: 'number', default: 180, min: 0, max: 100000, hint: 'Loaded salary cost of the people who run it, divided by hosts' },
      { id: 'network_host_month', label: 'Network per host per month', control: 'number', default: 120, min: 0, max: 100000 },
      { id: 'facilities_host_month', label: 'Facilities per host per month', control: 'number', default: 220, min: 0, max: 100000, hint: 'Space, power and cooling. Zero here makes every VM look cheaper than a cloud' },
      { id: 'storage_model', label: 'Storage', control: 'select', options: [{ value: 'hci', label: 'vSAN — inside the server price' }, { value: 'external', label: 'External arrays — priced per GB' }], default: 'hci' },
      { id: 'hci_compute_pct', label: 'Share of server price that is compute (%)', control: 'number', default: 70, min: 10, max: 95, showWhen: { input: 'storage_model', equals: ['hci'] }, hint: 'The rest is attributed to vSAN storage' },
      { id: 'storage_gb_month', label: 'Storage per GB per month', control: 'number', default: 0.08, min: 0, max: 100, showWhen: { input: 'storage_model', equals: ['external'] } },
      { id: 'cpu_share_pct', label: 'CPU share of compute cost (%)', control: 'number', default: 60, min: 5, max: 95, hint: 'The 9.1 custom cost ratio. Memory gets the rest' },
      {
        id: 'additional_costs',
        label: 'Additional costs (9.1)',
        control: 'textarea',
        default: 'datacenter | DC-North | fixed | - | 4000 | monthly | Colocation cross-connects\ncluster | wld01-cl01 | tag | CostCenter=Finance | 250 | monthly | Finance backup service\nhost | * | metric | cpu:corecount_provisioned | 2.5 | monthly | Per-core hardware support',
        hint: 'Applies to | Object | Method | Tag or metric | Amount | Period | Description',
        help: 'Applies to: cluster, host or datacenter. Object: its name, or * for every one. Method: fixed, tag (Category=value) or metric (a metric key, written with : where VCF Operations writes |; the amount is per unit). Period: monthly, yearly or one-time.',
      },
      {
        id: 'storage_costs',
        label: 'Storage cost per datastore or storage policy',
        control: 'textarea',
        default: 'storage policy | vSAN Default Storage Policy | 0.06\ndatastore | nfs-archive-01 | 0.02',
        hint: 'Kind | Name | Per GB per month',
        help: 'Kind: datastore, storage policy or datastore type. Overrides the datacenter storage rate for what it names.',
      },
      { id: 'max_swing_pct', label: 'Fail the check if a cluster’s cost moves more than (%)', control: 'number', default: 30, min: 1, max: 500 },
    ],
    automation: (values: BlueprintValues, name: string): Automation => {
      const dcs = listOf(str(values, 'datacenters', ''));
      const currency = str(values, 'currency', 'USD');
      const hosts = num(values, 'hosts', 8);
      const ownership = str(values, 'ownership', 'purchase');
      const bought = ownership === 'purchase';
      const serverCost = num(values, 'server_cost', 28000);
      const years = num(values, 'depreciation_years', 5);
      const method = str(values, 'depreciation_method', 'straight');
      const lease = num(values, 'lease_monthly', 700);
      const cores = num(values, 'cores_per_host', 64);
      const licence = num(values, 'licence_core_year', 350);
      const maintPct = num(values, 'maintenance_pct', 10);
      const labour = num(values, 'labour_host_month', 180);
      const network = num(values, 'network_host_month', 120);
      const facilities = num(values, 'facilities_host_month', 220);
      const storageModel = str(values, 'storage_model', 'hci');
      const hciCompute = num(values, 'hci_compute_pct', 70);
      const storageGb = num(values, 'storage_gb_month', 0.08);
      const cpuShare = num(values, 'cpu_share_pct', 60);
      const swing = num(values, 'max_swing_pct', 30);
      const base = slugOf(name || 'cost-drivers', 'cost-drivers');
      const extras = rowsOf(str(values, 'additional_costs', '')).map(([appliesTo = '', object = '', method = '', basis = '', amount = '', period = '', description = '']) => ({
        appliesTo: appliesTo.toLowerCase(),
        object,
        method: method.toLowerCase(),
        basis: basis === '-' ? '' : method.toLowerCase() === 'metric' ? basis.replace(/:/g, '|') : basis,
        amount: numOr(amount, NaN),
        period: period.toLowerCase(),
        description: description || `${appliesTo} ${object} ${method}`.trim(),
      }));
      const storageRows = rowsOf(str(values, 'storage_costs', '')).map(([kind = '', target = '', rate = '']) => ({ kind: kind.toLowerCase(), name: target, perGbMonth: numOr(rate, NaN) }));

      const hardwareMonth = bought ? serverCost / (Math.max(years, 1) * 12) : lease;
      const maintMonth = bought ? (serverCost * maintPct) / 100 / 12 : 0;
      const licenceMonth = (cores * licence) / 12;
      const hostMonth = hardwareMonth + maintMonth + licenceMonth + labour + network + facilities;
      const computeMonth = storageModel === 'hci' ? hostMonth - (hardwareMonth * (100 - hciCompute)) / 100 : hostMonth;

      const findings: Finding[] = [];
      if (dcs.length === 0) findings.push(error('vcfops.cost.no-datacenter', 'No datacenter is named, so there is nothing to enter these values against.', { source: SRC }));
      if (bought && (years < 2 || years > 5)) {
        findings.push(
          error('vcfops.cost.depreciation-range', `${years} years is outside the depreciation period VCF Operations accepts for server hardware (documented as 2 to 5 years).`, {
            remediation: 'Use the period finance actually depreciates servers over, within 2–5. If finance uses longer, enter 5 and note the difference in the design.',
            source: SRC,
          }),
        );
      } else if (bought && years < 3) {
        findings.push(
          warning('vcfops.cost.depreciation-short', `Depreciating servers over ${years} years is unrealistic for hardware that stays in the rack five or more.`, {
            remediation: 'A short period front-loads the cost: every VM looks expensive now and free in year three, and showback swings when the hardware is fully written down.',
            source: SRC,
          }),
        );
      }
      if (facilities === 0) {
        findings.push(
          warning('vcfops.cost.no-facilities', 'There is no facilities cost — no space, power or cooling.', {
            remediation: 'Facilities are typically a tenth to a fifth of the cost of running a host. Without them every VM is undercosted and every cloud comparison is unfair to the cloud.',
            source: SRC,
          }),
        );
      }
      if (bought && serverCost === 0) findings.push(warning('vcfops.cost.free-hardware', 'The server price is zero, so hardware contributes nothing to any VM’s cost.', { source: SRC }));
      if (cpuShare < 20 || cpuShare > 80) {
        findings.push(
          warning('vcfops.cost.ratio-extreme', `A ${cpuShare}:${100 - cpuShare} CPU:memory split puts almost all of a host’s cost on one resource.`, {
            remediation: 'Base the ratio on what the hardware cost: the share of the server price that is processors versus DIMMs is usually between 40:60 and 60:40.',
            source: SRC,
          }),
        );
      }
      if (licence === 0) findings.push(info('vcfops.cost.no-licence', 'Licence cost is zero. Deliberate if licences are costed centrally; otherwise VMs are undercosted by the largest single line.', { source: SRC }));
      extras.forEach((row, index) => {
        const where = `Additional cost row ${index + 1} (${row.description})`;
        if (!['cluster', 'host', 'datacenter'].includes(row.appliesTo)) findings.push(error('vcfops.cost.extra-target', `${where}: “${row.appliesTo}” is not cluster, host or datacenter — the three 9.1 applies additional costs to.`, { source: SRC }));
        if (!['fixed', 'tag', 'metric'].includes(row.method)) findings.push(error('vcfops.cost.extra-method', `${where}: method “${row.method}” is not fixed, tag or metric.`, { source: SRC }));
        if (row.method === 'tag' && !/^[^=]+=[^=]+$/.test(row.basis)) findings.push(error('vcfops.cost.extra-tag', `${where}: a tag-based cost needs the tag as Category=value.`, { source: SRC }));
        if (row.method === 'metric' && !/\|/.test(row.basis)) findings.push(error('vcfops.cost.extra-metric', `${where}: a metric-based cost needs the metric key (for example cpu:corecount_provisioned).`, { source: SRC }));
        if (!Number.isFinite(row.amount) || row.amount < 0) findings.push(error('vcfops.cost.extra-amount', `${where}: the amount is not a number.`, { source: SRC }));
        if (!['monthly', 'yearly', 'one-time'].includes(row.period)) findings.push(error('vcfops.cost.extra-period', `${where}: period “${row.period}” is not monthly, yearly or one-time.`, { source: SRC }));
        if (!row.object) findings.push(error('vcfops.cost.extra-object', `${where}: no object named; use * for every ${row.appliesTo}.`, { source: SRC }));
      });
      if (new Set(extras.map((row) => row.description)).size !== extras.length) findings.push(error('vcfops.cost.extra-duplicate', 'Two additional costs share a description. The apply script matches existing costs by description, so each needs its own.', { source: SRC }));
      storageRows.forEach((row, index) => {
        if (!['datastore', 'storage policy', 'datastore type'].includes(row.kind)) findings.push(error('vcfops.cost.storage-kind', `Storage cost row ${index + 1}: “${row.kind}” is not datastore, storage policy or datastore type.`, { source: SRC }));
        if (!row.name) findings.push(error('vcfops.cost.storage-name', `Storage cost row ${index + 1} names nothing.`, { source: SRC }));
        if (!Number.isFinite(row.perGbMonth) || row.perGbMonth < 0) findings.push(error('vcfops.cost.storage-rate', `Storage cost row ${index + 1}: the rate is not a number.`, { source: SRC }));
      });
      if (storageModel === 'external' && storageRows.some((row) => Number.isFinite(row.perGbMonth) && row.perGbMonth > storageGb * 5 && storageGb > 0)) {
        findings.push(warning('vcfops.cost.storage-outlier', 'A storage row is more than five times the datacenter storage rate.', { remediation: 'Check the unit: every rate here is per GB per month, not per TB.', source: SRC }));
      }

      const drivers: [string, string, string, string][] = [
        ['Server hardware', bought ? `${currency} ${money(serverCost)} per server, purchase, ${method === 'straight' ? 'straight line' : 'max of double declining or straight line'} over ${years} years` : `${currency} ${money(lease)} per server per month, lease`, `${money(hardwareMonth)}`, bought ? 'The price paid replaces the MSRP estimate the engine starts with. Set the purchase date per host in the 9.1 spreadsheet view.' : 'A lease is a monthly cost with no depreciation.'],
        ['Licence', `${currency} ${money(licence)} per core per year × ${cores} cores`, `${money(licenceMonth)}`, 'Per host. Guest OS licences can be added as their own line.'],
        ['Maintenance', bought ? `${maintPct}% of hardware price per year` : 'Included in the lease', `${money(maintMonth)}`, 'Support contracts on the hardware.'],
        ['Labour', `${currency} ${money(labour)} per host per month`, `${money(labour)}`, 'Operations staff, loaded, divided across hosts.'],
        ['Network', `${currency} ${money(network)} per host per month`, `${money(network)}`, 'Switch ports, uplinks and their support.'],
        ['Facilities', `${currency} ${money(facilities)} per host per month`, `${money(facilities)}`, facilities === 0 ? 'MISSING — see the findings.' : 'Space, power and cooling.'],
        ['Storage', storageModel === 'hci' ? `vSAN: ${100 - hciCompute}% of the server price is storage` : `${currency} ${storageGb} per GB per month`, storageModel === 'hci' ? `${money((hardwareMonth * (100 - hciCompute)) / 100)}` : 'per GB', storageModel === 'hci' ? 'On hyperconverged servers the engine splits the server price into compute and storage by this percentage.' : 'Entered per datastore type or per datastore.'],
      ];

      const design = [
        `# Cost drivers — ${dcs.join(', ') || '(no datacenter)'}`,
        '',
        '1. Reviewed values, and why each one.',
        `Currency: **${currency}**. Hosts per datacenter: **${hosts}**.`,
        '',
        `| Driver | Value | ${currency} per host per month | Why |`,
        '|---|---|---|---|',
        ...drivers.map(([driver, value, month, why]) => `| ${driver} | ${value} | ${month} | ${why} |`),
        `| **Total** | | **${money(hostMonth)}** | Before the storage split: ${money(computeMonth)} of it is compute. |`,
        '',
        `Per datacenter, per month: **${currency} ${money(hostMonth * hosts)}**. Per year: ${currency} ${money(hostMonth * hosts * 12)}.`,
        '',
        '## CPU:memory cost ratio (9.1)',
        '',
        `CPU **${cpuShare}%**, memory **${100 - cpuShare}%** of compute cost. Of ${currency} ${money(computeMonth)} per host per month,`,
        `${currency} ${money((computeMonth * cpuShare) / 100)} is charged to CPU and ${currency} ${money((computeMonth * (100 - cpuShare)) / 100)} to memory.`,
        'Base it on the bill of materials: what the processors cost against what the memory cost.',
        '',
        '## Additional costs (9.1)',
        '',
        ...(extras.length > 0
          ? ['| Applies to | Object | Method | Tag or metric | Amount | Period | Description |', '|---|---|---|---|---|---|---|', ...extras.map((row) => `| ${row.appliesTo} | ${row.object} | ${row.method} | ${row.basis || '—'} | ${currency} ${row.amount} | ${row.period} | ${row.description} |`)]
          : ['None.']),
        '',
        '## Storage cost per datastore or storage policy',
        '',
        ...(storageRows.length > 0 ? ['| Kind | Name | Per GB per month |', '|---|---|---|', ...storageRows.map((row) => `| ${row.kind} | ${row.name} | ${currency} ${row.perGbMonth} |`)] : ['None: the datacenter storage rate applies everywhere.']),
        '',
        '## Applying it',
        '',
        '1. `./apply-cost-drivers.sh` — takes the cost baseline (`cost-check.sh --baseline`) if there is none, sets the currency if it is unset, saves the cost drivers as they are (`cost-drivers-before-<time>.json`, the undo), changes only the values in `cost-drivers.json` that differ, writes them back, and reads them again to prove each one stuck. `--dry-run` stops before anything is written.',
        '2. The engine applies drivers at its next daily run. To see the result the same day, run the cost calculation from Administration → Control Panel → Cost Calculation — there is no documented API for starting it.',
        `3. \`./cost-check.sh --compare\`. It fails if any cluster’s cost moved more than ${swing}% — read why before anyone sees a bill.`,
        '',
        'Per-host purchase dates and prices in the 9.1 server hardware spreadsheet override the datacenter value for that host;',
        'this sets the datacenter value only.',
        '',
      ].join('\n');

      const csv = [
        'datacenter,driver,field,value,unit',
        ...dcs.flatMap((dc) => [
          ...(bought
            ? [`${dc},Server hardware,ownership,purchase,`, `${dc},Server hardware,price per server,${serverCost},${currency}`, `${dc},Server hardware,depreciation years,${years},years`, `${dc},Server hardware,depreciation method,${method === 'straight' ? 'Straight line' : 'Max of double declining or straight line'},`]
            : [`${dc},Server hardware,ownership,lease,`, `${dc},Server hardware,lease per month,${lease},${currency}`]),
          `${dc},Licence,per core per year,${licence},${currency}`,
          `${dc},Licence,cores per host,${cores},cores`,
          ...(bought ? [`${dc},Maintenance,percent of hardware per year,${maintPct},%`] : []),
          `${dc},Labour,per host per month,${labour},${currency}`,
          `${dc},Network,per host per month,${network},${currency}`,
          `${dc},Facilities,per host per month,${facilities},${currency}`,
          storageModel === 'hci' ? `${dc},Storage,compute share of server price,${hciCompute},%` : `${dc},Storage,per GB per month,${storageGb},${currency}`,
          `${dc},Cost ratio,CPU share,${cpuShare},%`,
          `${dc},Cost ratio,memory share,${100 - cpuShare},%`,
        ]),
        ...extras.map((row) => `${row.object},Additional cost (${row.appliesTo}; ${row.method}${row.basis ? ` ${row.basis}` : ''}; ${row.period}),${row.description.replace(/,/g, ' ')},${row.amount},${currency}`),
        ...storageRows.map((row) => `${row.name},Storage (${row.kind}),per GB per month,${row.perGbMonth},${currency}`),
        '',
      ].join('\n');

      type SetEntry = { scope: string; driver: string; field: string; value: number | string; label: string };
      const set: SetEntry[] = dcs.flatMap((dc): SetEntry[] => [
        ...(bought
          ? [
              { scope: dc, driver: 'server|hardware', field: 'price|purchase|cost', value: serverCost, label: 'Server hardware: price per server' },
              { scope: dc, driver: 'server|hardware', field: 'year|period|life', value: years, label: 'Server hardware: depreciation years' },
              { scope: dc, driver: 'server|hardware', field: 'method|depreciation', value: method === 'straight' ? 'STRAIGHT_LINE' : 'DOUBLE_DECLINING_BALANCE', label: 'Server hardware: depreciation method (VERIFY the enum)' },
              { scope: dc, driver: 'maint', field: 'percent|pct|rate', value: maintPct, label: 'Maintenance: % of hardware per year' },
            ]
          : [{ scope: dc, driver: 'server|hardware', field: 'lease|month|cost', value: lease, label: 'Server hardware: lease per month' }]),
        { scope: dc, driver: 'licen', field: 'core|price|cost', value: licence, label: 'Licence: per core per year' },
        { scope: dc, driver: 'labou?r', field: 'cost|month|value|amount', value: labour, label: 'Labour: per host per month' },
        { scope: dc, driver: 'network', field: 'cost|month|value|amount', value: network, label: 'Network: per host per month' },
        { scope: dc, driver: 'facilit', field: 'cost|month|value|amount', value: facilities, label: 'Facilities: per host per month' },
        storageModel === 'hci'
          ? { scope: dc, driver: 'storage', field: 'compute|share|percent', value: hciCompute, label: 'Storage: compute share of server price' }
          : { scope: dc, driver: 'storage', field: 'gb|rate|cost|price', value: storageGb, label: 'Storage: per GB per month' },
        { scope: dc, driver: 'ratio|cpu.?mem', field: 'cpu', value: cpuShare, label: 'Cost ratio: CPU share %' },
      ]);
      for (const row of storageRows) set.push({ scope: row.name, driver: 'storage', field: 'gb|rate|cost|price', value: row.perGbMonth, label: `Storage (${row.kind}) ${row.name}: per GB per month` });

      const want = {
        $comment: 'What apply-cost-drivers.sh sets. Each "set" entry finds exactly one object named scope, inside it exactly one driver whose name matches driver, and in that exactly one field matching field; it refuses on none or several, and prints the candidates. Adjust a regex here when it does.',
        currency,
        set,
        additionalCosts: extras.map((row) => ({ appliesTo: row.appliesTo, object: row.object, method: row.method, basis: row.basis, amount: row.amount, period: row.period, description: row.description })),
      };

      const apply = [
        '#!/usr/bin/env bash',
        '# Apply cost-drivers.json: currency, cost drivers, CPU:memory ratio, additional',
        '# costs and storage costs. Read → change what differs → PUT → read back.',
        '#',
        '# The cost-driver API is not in the public API reference; VCF Operations serves',
        '# it under /suite-api/internal (VERIFY the path on your build and set DRIVERS_PATH).',
        '# Field names are not assumed: every value is placed by matching names in what',
        '# the API returns, and the script refuses rather than guess when a match is',
        '# missing or ambiguous. --dry-run stops before anything is written.',
        'set -euo pipefail',
        '',
        ...authPreamble(PLATFORM),
        'for tool in curl jq python3; do command -v "$tool" >/dev/null || { echo "$tool is required" >&2; exit 2; }; done',
        'EXECUTE=1',
        '[[ "${1:-}" == "--dry-run" ]] && EXECUTE=0',
        'HERE=$(cd "$(dirname "$0")" && pwd)',
        'WANT="$HERE/cost-drivers.json"',
        'STAMP=$(date +%Y%m%d-%H%M%S)',
        'WORK=$(umask 077; mktemp -d)',
        `trap 'rm -rf "$WORK"${AUTH_FILE_VAR ? `; rm -f "$${AUTH_FILE_VAR}"` : ''}' EXIT`,
        ...API_FN,
        ...GLOBAL_SETTING_FN,
        'DRIVERS_PATH="${DRIVERS_PATH:-/suite-api/internal/costdrivers}"',
        '',
        '# 1. The baseline cost-check.sh compares against, if there is none yet.',
        'if [[ ! -f "$HERE/cost-baseline.json" ]]; then (cd "$HERE" && ./cost-check.sh --baseline); fi',
        '',
        '# 2. Currency: set if unset. Never changed once set — it is not a conversion.',
        'CUR=$(jq -r .currency "$WANT")',
        'api GET "$GLOBALS_PATH" >"$WORK/globals.json"',
        'now=$(jq -r \'[(.keyValues // .globalSettings // .settings // [])[]? | select((.key // .name) | strings | test("currency"; "i")) | ((.values // [])[0] // .value // "")][0] // ""\' "$WORK/globals.json")',
        'if [[ -n "$now" && "$now" != "$CUR" && "${FORCE_CURRENCY:-0}" != 1 ]]; then',
        '  echo "The currency is already ${now}. Changing it to ${CUR} relabels every cost without converting it; refusing. FORCE_CURRENCY=1 if that is really meant." >&2',
        '  exit 2',
        'fi',
        'set_global "currency" "$CUR" "Currency"',
        '',
        '# 3. The cost drivers.',
        'code=$(probe "$DRIVERS_PATH")',
        'if [[ "$code" != 200 ]]; then',
        '  echo "GET ${DRIVERS_PATH} returned HTTP ${code}: no cost-driver API at that path on this build." >&2',
        '  echo "Set DRIVERS_PATH to the path your build lists (its API documentation, search \\"cost driver\\"), or enter cost-drivers.csv under Manage → Cost → Cost Drivers." >&2',
        '  exit 3',
        'fi',
        'BEFORE="$HERE/cost-drivers-before-${STAMP}.json"',
        'api GET "$DRIVERS_PATH" >"$BEFORE"',
        'echo "Saved the cost drivers as they are: ${BEFORE} (the undo)."',
        '',
        'cat >"$WORK/drivers.py" <<\'PY\'',
        'import copy, json, re, sys',
        'mode, cur_path, want_path = sys.argv[1:4]',
        'out_path = sys.argv[4] if len(sys.argv) > 4 else None',
        'cur = json.load(open(cur_path)); want = json.load(open(want_path))',
        'NAMES = ("name", "displayName", "label", "driverName", "costDriverName", "type", "category", "datacenterName", "resourceName", "datastoreName", "policyName", "description")',
        'def nodes(n):',
        '    if isinstance(n, dict):',
        '        yield n',
        '        for v in n.values(): yield from nodes(v)',
        '    elif isinstance(n, list):',
        '        for v in n: yield from nodes(v)',
        'def names(d): return [str(d[k]) for k in NAMES if isinstance(d.get(k), (str, int)) and not isinstance(d.get(k), bool)]',
        'problems, changes, missing = [], [], []',
        'def one(items, what, hint=""):',
        '    if len(items) != 1:',
        '        problems.append("%s: %d matches%s" % (what, len(items), hint)); return None',
        '    return items[0]',
        'def is_num(v): return isinstance(v, (int, float)) and not isinstance(v, bool)',
        'for e in want["set"]:',
        '    scope = cur if e["scope"] == "*" else one([d for d in nodes(cur) if e["scope"] in names(d)], "%s: object %r" % (e["label"], e["scope"]))',
        '    if scope is None: continue',
        '    drv = one([d for d in nodes(scope) if any(re.search(e["driver"], n, re.I) for n in names(d))], "%s: driver /%s/ in %r" % (e["label"], e["driver"], e["scope"]))',
        '    if drv is None: continue',
        '    want_num = is_num(e["value"])',
        '    keys = [k for k, v in drv.items() if (is_num(v) if want_num else isinstance(v, str)) and re.search(e["field"], k, re.I)]',
        '    k = one(keys, "%s: field /%s/" % (e["label"], e["field"]), " (fields: %s)" % ", ".join(sorted(drv.keys())))',
        '    if k is None: continue',
        '    if drv[k] != e["value"]:',
        '        if mode == "check": missing.append("%s: %s is %r, wanted %r" % (e["label"], k, drv[k], e["value"]))',
        '        else: changes.append("%s: %s %r -> %r" % (e["label"], k, drv[k], e["value"])); drv[k] = e["value"]',
        'extras = want.get("additionalCosts") or []',
        'if extras:',
        '    lists = [(d, k) for d in nodes(cur) for k, v in d.items() if isinstance(v, list) and re.search("additional", k, re.I)]',
        '    hit = one(lists, "additional costs: a list whose key contains \\"additional\\"")',
        '    if hit is not None:',
        '        holder, key = hit; items = holder[key]',
        '        def has(desc): return any(desc in [str(v) for v in i.values() if isinstance(v, str)] for i in items if isinstance(i, dict))',
        '        for x in extras:',
        '            if has(x["description"]): continue',
        '            if mode == "check": missing.append("additional cost %r is not there" % x["description"]); continue',
        '            if not items or not isinstance(items[0], dict):',
        '                problems.append("additional costs: none exists to copy the shape of. Create one in the interface (Manage → Cost → Cost Drivers → Additional Costs), then run again"); break',
        '            new = copy.deepcopy(items[0])',
        '            for idk in [k for k in new if re.fullmatch("id|uuid|key", k, re.I)]: del new[idk]',
        '            def put(regex, value, numeric=False, need=True):',
        '                ks = [k for k, v in new.items() if (is_num(v) if numeric else isinstance(v, str)) and re.search(regex, k, re.I)]',
        '                if len(ks) == 1: new[ks[0]] = value',
        '                elif need: problems.append("additional cost %r: field /%s/ matched %r (fields: %s)" % (x["description"], regex, ks, ", ".join(sorted(new))))',
        '            for k in [k for k, v in new.items() if isinstance(v, str) and re.fullmatch("name|description|label", k, re.I)]: new[k] = x["description"]',
        '            put("amount|cost|value|price", x["amount"], numeric=True)',
        '            put("level|appliesTo|objectType|entityType|target", x["appliesTo"].upper())',
        '            put("objectName|resourceName|entityName|targetName", "" if x["object"] == "*" else x["object"], need=x["object"] != "*")',
        '            put("method|basis|calculation", x["method"].upper())',
        '            put("tag|metric|expression|statKey", x["basis"], need=x["method"] != "fixed")',
        '            put("period|frequency|recurrence", x["period"].upper().replace("-", "_"))',
        '            items.append(new); changes.append("additional cost %r added" % x["description"])',
        'for p in problems: print("REFUSED: " + p, file=sys.stderr)',
        'if problems: sys.exit(3)',
        'if mode == "check":',
        '    for m in missing: print("DID NOT STICK: " + m)',
        '    sys.exit(1 if missing else 0)',
        'for c in changes: print(c)',
        'json.dump(cur, open(out_path, "w"), indent=2)',
        'print("%d change(s)." % len(changes))',
        'PY',
        '',
        'python3 "$WORK/drivers.py" merge "$BEFORE" "$WANT" "$WORK/after.json"',
        'if (( ! EXECUTE )); then',
        '  echo "DRY RUN: would PUT the changed cost drivers to https://${VCFOPS_HOST}${DRIVERS_PATH}. Dry run: nothing was changed. Run it without --dry-run to apply."',
        '  exit 0',
        'fi',
        'api PUT "$DRIVERS_PATH" -H "Content-Type: application/json" --data-binary @"$WORK/after.json" >/dev/null',
        'api GET "$DRIVERS_PATH" >"$WORK/readback.json"',
        'if ! python3 "$WORK/drivers.py" check "$WORK/readback.json" "$WANT"; then',
        '  echo "Written, but not every value reads back. Undo: PUT ${BEFORE} to ${DRIVERS_PATH}." >&2',
        '  exit 1',
        'fi',
        'echo "Applied and read back. The cost engine uses it from its next daily run; then ./cost-check.sh --compare."',
        'echo "Undo: curl -X PUT the file ${BEFORE} to ${DRIVERS_PATH} the same way."',
        '',
      ].join('\n');

      const check = readScript('vcf-operations', 'Snapshot, and compare, the cost the engine calculates for every cluster.', [
        ...POST_QUERY,
        ...LARGE_DATA,
        `MAX_SWING_PCT=${swing}`,
        'MODE="${1:---compare}"',
        'BASELINE="${BASELINE:-cost-baseline.json}"',
        '',
        'get_all "/suite-api/api/resources?adapterKind=VMWARE&resourceKind=ClusterComputeResource" "$WORK/all.json"',
        "jq -c '[.[] | {id: .identifier, name: .resourceKey.name}]' \"$WORK/all.json\" >\"$WORK/clusters.json\"",
        'if [[ "$(jq length "$WORK/clusters.json")" == 0 ]]; then echo "No clusters found." >&2; exit 1; fi',
        'first=$(jq -r ".[0].id" "$WORK/clusters.json")',
        ...costKeyDiscovery('first', '^cost\\|'),
        '# The metric compared is the first cost key with "total" in it. VERIFY it is the',
        '# monthly total in your release, or set COST_KEY to the one you want.',
        'COST_KEY="${COST_KEY:-$(jq -r \'[.[] | select(test("total"; "i"))][0] // .[0]\' <<<"$keys")}"',
        'echo "Comparing on ${COST_KEY}"',
        '',
        'jq -c \'[.[].id]\' "$WORK/clusters.json" >"$WORK/ids.json"',
        'latest_map "$WORK/ids.json" "$WORK/keys.json" "$WORK/latest.json"',
        'now="$WORK/now.json"',
        'jq -c --slurpfile v "$WORK/latest.json" \'($v[0]) as $v | [.[] | {name, id, stats: ($v[.id] // {})}]\' "$WORK/clusters.json" >"$now"',
        '',
        'case "$MODE" in',
        '  --baseline)',
        '    cp "$now" "$BASELINE"',
        '    echo "Saved $(jq length "$now") clusters to ${BASELINE}. Make the cost driver change, run the cost calculation, then --compare."',
        '    exit 0 ;;',
        '  --compare)',
        '    [[ -f "$BASELINE" ]] || { echo "No ${BASELINE}. Run with --baseline before changing anything." >&2; exit 2; }',
        '    report=$(jq -c --slurpfile b "$BASELINE" --arg k "$COST_KEY" --argjson max "$MAX_SWING_PCT" \'',
        '      ($b[0] | map({(.id): .stats[$k]}) | add // {}) as $old',
        '      | [.[] | {name, before: $old[.id], after: .stats[$k]}',
        '         | .pct = (if (.before // 0) == 0 then null else (((.after // 0) - .before) / .before * 100 | . * 10 | round / 10) end)',
        '         | .over = (.pct != null and ((.pct | fabs) > $max))]\' "$now")',
        '    jq -r \'.[] | "\\(.name)\\t\\(.before)\\t->\\t\\(.after)\\t\\(.pct // "n/a")%\\(if .over then "\\tOVER" else "" end)"\' <<<"$report"',
        '    over=$(jq \'[.[] | select(.over)] | length\' <<<"$report")',
        '    if (( over > 0 )); then',
        '      echo "${over} cluster(s) moved more than ${MAX_SWING_PCT}%. Find out why before a bill goes out." >&2',
        '      exit 1',
        '    fi',
        '    echo "Every cluster within ${MAX_SWING_PCT}%." ;;',
        '  *) echo "usage: $0 --baseline | --compare" >&2; exit 2 ;;',
        'esac',
      ]);

      return {
        platform: PLATFORM,
        title: `Cost drivers for ${dcs.join(', ') || 'no datacenter'} — ${currency} ${money(hostMonth)} per host per month, CPU:memory ${cpuShare}:${100 - cpuShare}`,
        effect: 'reversible',
        trigger: { kind: 'manual', detail: 'Applied once as a change by apply-cost-drivers.sh, then reviewed each budget year or hardware refresh.' },
        scope: {
          what: `Every cost VCF Operations calculates in ${dcs.join(', ') || '(none)'}: host, cluster, VM, and everything showback and bills are built from.`,
          decidedBy: ['The datacenter each driver is entered against.', 'The per-host values in the 9.1 server hardware editor, which override the datacenter default for that host.', 'The daily cost calculation, which applies them from its next run.'],
          ifWrong: 'Every VM cost, every showback line and every bill is wrong by the same factor, and looks authoritative. Nothing fails; people pay or budget from it.',
        },
        guardrails: [
          { rule: 'Baseline before, compare after — cost-check.sh', because: `It fails when a cluster’s cost moves more than ${swing}%, which is how a zero in the wrong field is caught before a tenant sees it on a bill.` },
          { rule: 'Every value is placed by matching names in what the API returns, and the script refuses on no match or several', because: 'The cost-driver document is not in the public API reference. A value written to a guessed field is silently ignored; a refusal with the candidate fields printed is fixed in a minute.' },
          { rule: 'Read back after the PUT; exit 1 if any value did not stick', because: 'An API that accepts a document and drops part of it is the failure nobody notices until the bill.' },
          { rule: 'Never changes a currency already set (FORCE_CURRENCY=1 to override)', because: 'Changing the currency relabels every cost without converting it.' },
          { rule: 'Every value has a reason in the design table', because: 'A cost driver nobody can explain is the engine’s default, and the default is an MSRP guess.' },
        ],
        dryRun: [
          'apply-cost-drivers.sh --dry-run: takes the baseline, saves the drivers as they are, prints every change it would make, and writes nothing.',
          'Compare the per-host total in the design with what finance says a host costs. If they differ by more than the swing you set, one of them is wrong.',
        ],
        undo: ['PUT the cost-drivers-before-<time>.json the run saved back to the same path, and run the cost calculation again. Past daily cost metrics already written are not recalculated.'],
        told: ['Nobody automatically. Cost changes flow into showback and bills silently — record the change, and tell the people who read bills before the next one goes out.'],
        requires: ['jq and python3 on the machine that runs the scripts.', 'The real price paid, purchase dates and lease terms from finance, not the engine’s estimates.', ...(extras.length > 0 ? ['One additional cost created once in the interface, if none exists yet: the script copies its shape for the rest.'] : [])],
        files: {
          [`${base}-design.md`]: design,
          [`${base}-values.csv`]: csv,
          'cost-drivers.json': `${JSON.stringify(want, null, 2)}\n`,
          'apply-cost-drivers.sh': apply,
          'cost-check.sh': check,
          'IMPORT.md': importMd({
            title: 'the cost drivers',
            intro: ['Cost drivers are not a file VCF Operations imports: apply-cost-drivers.sh writes them through the API. The CSV is the record of what was set and why.'],
            steps: [
              { heading: 'Apply', files: ['cost-drivers.json', 'apply-cost-drivers.sh'], how: ['./apply-cost-drivers.sh — baseline, currency, drivers, additional costs and storage costs, then a read-back. --dry-run prints the changes and writes nothing.'], verify: ['the cost-driver path (DRIVERS_PATH, default /suite-api/internal/costdrivers) and the global settings path (GLOBALS_PATH). The script stops with the HTTP status if either is not there.'] },
              { heading: 'Compare', files: ['cost-check.sh'], how: ['After the next daily cost calculation: ./cost-check.sh --compare. It exits 1 when a cluster moved more than the swing you set.'] },
            ],
          }),
        },
        notes: [
          'VCF 9.1 applies additional cost drivers to clusters, hosts and datacenters, not only VMs — an “additional cost” entered at datacenter level is spread across what is in it. Fixed, tag-based (every object carrying the tag) and metric-based (amount per unit of a metric) are the three methods.',
          'The engine only recalculates forward. A change made on the 20th leaves the first nineteen days of the month at the old rates, so make it on the first.',
          'The cost key cost-check.sh compares on is discovered from the first cluster’s stat keys. Set COST_KEY if it picks the wrong one.',
          'VERIFY: the cost-driver API is served under /suite-api/internal on the builds this was written against, and its field names are not published. The script matches by name and refuses rather than guess; where it refuses, adjust the regex in cost-drivers.json it names.',
          'There is no documented API that starts the cost calculation. Administration → Control Panel → Cost Calculation → Run, or wait for the daily run.',
        ],
        findings,
      };
    },
  }),

  // -------------------------------------------------------------------------
  automationBlueprint({
    id: 'vcfops_showback',
    platform: PLATFORM,
    label: 'Showback and chargeback: a rate card, assigned, billed and emailed',
    group: 'Cost',
    description:
      'A pricing policy with rates per vCPU, per GB of memory, per GB of storage (and per storage policy), a fixed charge per VM and VKS node prices per VM class, created or updated through the pricing API from one policy made once in the interface — so the item names are the platform’s, not a guess — in the currency the cost engine runs in, with 9.1 upfront pricing shown to requesters in VCF Automation. Then the 9.1 pieces around it: assignment to organizations, projects or a cost-centre tag, application showback with the service-type filter, tenant reports and alerts, and a recurring bill sent as PDF by email.',
    inputs: [
      { id: 'policy_name', label: 'Pricing policy name', control: 'text', default: 'Standard rate card 2027' },
      { id: 'currency', label: 'Currency', control: 'select', options: CURRENCIES, default: 'USD', hint: 'Must be the currency the cost engine runs in; build-policy.sh refuses otherwise' },
      { id: 'basis', label: 'Charge on', control: 'select', options: [{ value: 'allocation', label: 'Allocation — what was asked for' }, { value: 'usage', label: 'Usage — what was used' }], default: 'allocation', hint: 'Set on the template policy; the clone keeps it' },
      { id: 'rate_vcpu', label: 'Per vCPU per month', control: 'number', default: 18, min: 0, max: 10000 },
      { id: 'rate_ram', label: 'Per GB memory per month', control: 'number', default: 4, min: 0, max: 10000 },
      { id: 'rate_storage', label: 'Per GB storage per month', control: 'number', default: 0.1, min: 0, max: 1000 },
      { id: 'fixed_vm', label: 'Fixed per VM per month', control: 'number', default: 5, min: 0, max: 100000 },
      { id: 'storage_policy_rates', label: 'Storage price per storage policy', control: 'textarea', default: 'vSAN Default Storage Policy | 0.12\nGold - FTT2 RAID1 | 0.25', hint: 'Storage policy | Per GB per month', help: 'Overrides the flat storage rate for disks on that policy. The template policy needs an item for each.' },
      { id: 'vks_pricing', label: 'Price VKS nodes per VM class (9.1)', control: 'toggle', default: true },
      { id: 'vks_rates', label: 'VKS node price per VM class', control: 'textarea', default: 'best-effort-small | 25\nbest-effort-medium | 48\nguaranteed-large | 160', hint: 'VM class | Per node per month', showWhen: { input: 'vks_pricing', equals: ['true'] } },
      { id: 'upfront_pricing', label: 'Show upfront prices in VCF Automation (9.1)', control: 'toggle', default: true, hint: 'Requesters see the estimate from this policy before they deploy' },
      {
        id: 'service_type',
        label: 'Showback and bills cover',
        control: 'select',
        options: [
          { value: 'all', label: 'Every service type, shown separately' },
          { value: 'vm', label: 'Regular VMs only' },
          { value: 'vks', label: 'VKS only' },
          { value: 'dsm', label: 'Data Services Manager only' },
        ],
        default: 'all',
        hint: 'The 9.1 VM cost filter by service type, so VKS node VMs and DSM VMs are not billed twice',
      },
      { id: 'assign_to', label: 'Assign to', control: 'select', options: [{ value: 'organization', label: 'VCF Automation organizations' }, { value: 'project', label: 'VCF Automation projects' }, { value: 'tag', label: 'VMs by a cost-centre tag' }], default: 'organization' },
      { id: 'assign_names', label: 'Organizations or projects', control: 'text', default: 'Finance, Retail', showWhen: { input: 'assign_to', equals: ['organization', 'project'] } },
      { id: 'tag_category', label: 'Tag category that carries the cost centre', control: 'text', default: 'CostCenter', showWhen: { input: 'assign_to', equals: ['tag'] }, hint: 'Same category as the tag standard; one value per cost centre' },
      { id: 'bill_cadence', label: 'Bills', control: 'select', options: [{ value: 'monthly', label: 'Monthly' }, { value: 'quarterly', label: 'Quarterly' }, { value: 'none', label: 'No bills — showback only' }], default: 'monthly' },
      { id: 'bill_recipients', label: 'Email bills to', control: 'text', default: 'showback@example.com', showWhen: { input: 'bill_cadence', notEquals: ['none'] } },
      { id: 'tenant_alert_pct', label: 'Alert a tenant at (% of quota)', control: 'number', default: 80, min: 0, max: 100, hint: '0 turns tenant alerts off' },
      { id: 'app_showback', label: 'Show cost per application and tier', control: 'toggle', default: true },
    ],
    automation: (values: BlueprintValues, name: string): Automation => {
      const policyName = str(values, 'policy_name', 'Rate card');
      const basis = str(values, 'basis', 'allocation');
      const rVcpu = num(values, 'rate_vcpu', 18);
      const rRam = num(values, 'rate_ram', 4);
      const rStorage = num(values, 'rate_storage', 0.1);
      const fixed = num(values, 'fixed_vm', 5);
      const assignTo = str(values, 'assign_to', 'organization');
      const names = listOf(str(values, 'assign_names', ''));
      const tagCategory = str(values, 'tag_category', '');
      const cadence = str(values, 'bill_cadence', 'monthly');
      const recipients = listOf(str(values, 'bill_recipients', ''));
      const alertPct = num(values, 'tenant_alert_pct', 80);
      const appShowback = bool(values, 'app_showback', true);
      const currency = str(values, 'currency', 'USD');
      const storagePolicyRates = rowsOf(str(values, 'storage_policy_rates', '')).map(([policy = '', rate = '']) => ({ policy, rate: numOr(rate, NaN) }));
      const vksPricing = bool(values, 'vks_pricing', true);
      const vksRates = vksPricing ? rowsOf(str(values, 'vks_rates', '')).map(([vmClass = '', rate = '']) => ({ vmClass, rate: numOr(rate, NaN) })) : [];
      const upfront = bool(values, 'upfront_pricing', true);
      const serviceType = str(values, 'service_type', 'all');
      const serviceLabel: Record<string, string> = { all: 'every service type, shown separately', vm: 'regular VMs only', vks: 'VKS only', dsm: 'Data Services Manager only' };
      const base = slugOf(name || policyName, 'rate-card');
      const bills = cadence !== 'none';
      const reEscape = (text: string): string => text.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

      const findings: Finding[] = [];
      if (rVcpu + rRam + rStorage + fixed === 0) findings.push(error('vcfops.showback.all-zero', 'Every rate is zero, so every bill is zero.', { source: SRC }));
      if (assignTo === 'tag' && !tagCategory.trim()) findings.push(error('vcfops.showback.no-tag', 'Tag-based assignment needs the tag category that carries the cost centre.', { source: SRC }));
      if (assignTo !== 'tag' && names.length === 0) findings.push(error('vcfops.showback.unassigned', 'A pricing policy assigned to nothing prices nothing.', { source: SRC }));
      if (bills && recipients.length === 0) findings.push(error('vcfops.showback.no-recipient', 'Bills are scheduled with nobody to send them to.', { source: SRC }));
      if (basis === 'usage') {
        findings.push(
          warning('vcfops.showback.usage', 'Charging on usage makes a tenant’s bill depend on how busy their VMs were, and oversized VMs cost them almost nothing.', {
            remediation: 'Allocation-based pricing charges for what was reserved, which is what drives the hardware you buy. VCF Automation’s upfront pricing estimates are also allocation-based.',
            source: SRC,
          }),
        );
      }
      storagePolicyRates.forEach((row, index) => {
        if (!row.policy || !Number.isFinite(row.rate) || row.rate < 0) findings.push(error('vcfops.showback.storage-policy-row', `Storage policy price row ${index + 1} needs a storage policy name and a price per GB.`, { source: SRC }));
      });
      vksRates.forEach((row, index) => {
        if (!row.vmClass || !Number.isFinite(row.rate) || row.rate < 0) findings.push(error('vcfops.showback.vks-row', `VKS price row ${index + 1} needs a VM class and a price per node.`, { source: SRC }));
      });
      if (vksPricing && vksRates.length === 0) findings.push(error('vcfops.showback.vks-empty', 'VKS pricing is on with no VM class priced, so every VKS node is priced at zero.', { source: SRC }));
      if (serviceType === 'all' && vksPricing) {
        findings.push(
          info('vcfops.showback.vks-twice', 'VKS nodes are VMs. With VKS priced per node and VMs priced per vCPU, a showback that does not separate service types charges the same node twice.', {
            remediation: 'Keep the service-type filter on the showback dashboards and bills: regular VMs, VKS and DSM each once.',
            source: SRC,
          }),
        );
      }
      if (upfront && basis === 'usage') {
        findings.push(
          warning('vcfops.showback.upfront-usage', 'Upfront prices in VCF Automation are estimates made before anything runs, so on a usage-based policy they cannot match the bill.', {
            remediation: 'Price on allocation when requesters are shown an upfront price, or turn upfront pricing off.',
            source: SRC,
          }),
        );
      }
      if (assignTo === 'tag') {
        findings.push(
          info('vcfops.showback.untagged', `VMs with no ${tagCategory} tag fall outside a tag-based policy and are priced by whatever policy is next — often the default.`, {
            remediation: 'Report untagged VMs every month, and make the tag mandatory in the VCF Automation template so new VMs cannot be untagged.',
            source: SRC,
          }),
        );
      }

      const card = {
        $comment: 'Rate card. build-policy.sh sets each rate on the items of a template pricing policy whose itemName matches the regex (an item takes the first rate that matches; the most specific come first), in the currency the cost engine runs in.',
        name: policyName,
        description: `${basis === 'allocation' ? 'Allocation' : 'Usage'} based; per month; ${currency}; covers ${serviceLabel[serviceType] ?? serviceType}.`,
        currency,
        serviceType,
        upfrontPricing: upfront,
        rates: [
          ...vksRates.map((row) => ({ label: `VKS node, ${row.vmClass}`, match: `(vks|kubernetes|node).*${reEscape(row.vmClass)}|${reEscape(row.vmClass)}`, rate: row.rate })),
          ...storagePolicyRates.map((row) => ({ label: `Storage policy ${row.policy}, per GB`, match: reEscape(row.policy), rate: row.rate })),
          { label: 'vCPU', match: 'cpu', rate: rVcpu },
          { label: 'Memory GB', match: 'mem|ram', rate: rRam },
          { label: 'Storage GB', match: 'storage|disk', rate: rStorage },
          ...(fixed > 0 ? [{ label: 'Fixed per VM', match: 'vm|fixed|recurring', rate: fixed }] : []),
        ],
      };

      const build = [
        '#!/usr/bin/env bash',
        `# Create or update the pricing policy "${policyName}" from a template policy and`,
        '# rate-card.json, then read it back.',
        '#',
        '# Why a template: the pricing API documents the shape of a policy but not the',
        '# item names, units or charge periods it expects. A policy made once in the',
        '# interface carries all of them, so this copies its structure and changes only',
        '# the numbers. It refuses if a rate matches no item, rather than guessing.',
        '# A policy with the same name is updated in place (PUT), so running it again is safe.',
        '#',
        '# It applies when run; --dry-run only prints the policy it would send.',
        'set -euo pipefail',
        ...authPreamble(PLATFORM),
        ': "${TEMPLATE_POLICY_ID:?set TEMPLATE_POLICY_ID: create one policy in the interface with every item priced, then GET /suite-api/api/pricing and take its id}"',
        'command -v jq >/dev/null || { echo "jq is required" >&2; exit 2; }',
        'HERE=$(cd "$(dirname "$0")" && pwd)',
        'CARD="${CARD:-$HERE/rate-card.json}"',
        'EXECUTE=1',
        '[[ "${1:-}" == "--dry-run" ]] && EXECUTE=0',
        'WORK=$(umask 077; mktemp -d)',
        `trap 'rm -rf "$WORK"${AUTH_FILE_VAR ? `; rm -f "$${AUTH_FILE_VAR}"` : ''}' EXIT`,
        ...API_FN,
        '',
        '# The currency the rate card is in has to be the one the cost engine runs in.',
        'GLOBALS_PATH="${GLOBALS_PATH:-/suite-api/api/deployment/config/globalsettings}"',
        'want_cur=$(jq -r .currency "$CARD")',
        'if [[ "$(probe "$GLOBALS_PATH")" == 200 ]]; then',
        '  now=$(api GET "$GLOBALS_PATH" | jq -r \'[(.keyValues // .globalSettings // .settings // [])[]? | select((.key // .name) | strings | test("currency"; "i")) | ((.values // [])[0] // .value // "")][0] // ""\')',
        '  if [[ -z "$now" ]]; then echo "No currency is set in VCF Operations, so nothing is priced. Run apply-cost-drivers.sh (Cost drivers) first." >&2; exit 2; fi',
        '  if [[ "$now" != "$want_cur" ]]; then echo "The cost engine runs in ${now}; this rate card is in ${want_cur}. Refusing: prices would be read in the wrong currency." >&2; exit 2; fi',
        '  echo "Currency ${now}, as the rate card."',
        'else',
        '  echo "Could not read the global settings at ${GLOBALS_PATH} (VERIFY the path). Check the currency is ${want_cur} under Global Settings by hand." >&2',
        'fi',
        '',
        'name=$(jq -r .name "$CARD")',
        'api GET /suite-api/api/pricing >"$WORK/all.json"',
        'existing=$(jq -r --arg n "$name" \'[.policies[]? | select(.name == $n) | .id] | .[]\' "$WORK/all.json")',
        'if (( $(grep -c . <<<"$existing") > 1 )); then echo "More than one pricing policy is named \\"${name}\\". Rename one in the interface first." >&2; exit 2; fi',
        '',
        'api GET "/suite-api/api/pricing/${TEMPLATE_POLICY_ID}" >"$WORK/tpl.json"',
        '',
        "missing=$(jq -r --slurpfile c \"$CARD\" '",
        '  [.. | objects | select(has("itemName")) | .itemName | ascii_downcase] as $items',
        '  | $c[0].rates[] | .match as $re | select([$items[] | test($re)] | any | not) | "\\(.label) (/\\($re)/)"\' "$WORK/tpl.json")',
        'if [[ -n "$missing" ]]; then',
        '  echo "These rates match no item in the template policy, so they would be silently dropped:" >&2',
        '  echo "$missing" >&2',
        '  echo "Items the template has:" >&2',
        '  jq -r \'.. | objects | select(has("itemName")) | "  " + .itemName\' "$WORK/tpl.json" >&2',
        '  echo "Price those items in the template, or change the match in ${CARD}." >&2',
        '  exit 2',
        'fi',
        '',
        '# Each item takes the first rate whose regex matches its name.',
        "jq --slurpfile c \"$CARD\" --arg id \"$existing\" '",
        '  ($c[0]) as $c',
        '  | def rate($item): [$c.rates[] | .match as $re | select($item | ascii_downcase | test($re))][0].rate;',
        '  del(.id, .links, .lastUpdateTimestamp, .createdBy)',
        '  | (if $id != "" then .id = $id else . end)',
        '  | .name = $c.name | .description = $c.description',
        '  | walk(if type == "object" and has("itemName") then (rate(.itemName)) as $r',
        '      | if $r == null then .',
        '        elif (.metering | type) == "object" then .metering.baseRate = $r',
        '        elif (.unconditionalMetering | type) == "object" then .unconditionalMetering.rate = $r',
        '        elif has("baseRate") then .baseRate = $r',
        '        elif has("rate") then .rate = $r',
        '        else . end',
        '    else . end)\' "$WORK/tpl.json" >"$WORK/policy.json"',
        '',
        '# 9.1 upfront pricing in VCF Automation: a flag on the policy, found by name (VERIFY).',
        'if [[ "$(jq -r .upfrontPricing "$CARD")" == true ]]; then',
        '  flag=$(jq -r \'[to_entries[] | select((.value | type) == "boolean" and (.key | test("upfront|showprice|displayprice"; "i"))) | .key] | if length == 1 then .[0] else "" end\' "$WORK/policy.json")',
        '  if [[ -n "$flag" ]]; then',
        '    jq --arg f "$flag" \'.[$f] = true\' "$WORK/policy.json" >"$WORK/p2.json" && mv "$WORK/p2.json" "$WORK/policy.json"',
        '    echo "Upfront pricing: ${flag} = true."',
        '  else',
        '    UPFRONT_MANUAL=1',
        '  fi',
        'fi',
        '',
        'listing() { jq -r \'.. | objects | select(has("itemName")) | "  \\(.itemName)\\t\\(.metering.baseRate // .unconditionalMetering.rate // .baseRate // .rate // "")"\' "$1" | sort; }',
        'echo "Rates as they will be set:"',
        'listing "$WORK/policy.json"',
        '',
        'if (( ! EXECUTE )); then',
        '  echo "DRY RUN: would $([[ -n "$existing" ]] && echo "PUT (update ${existing})" || echo POST) this policy to https://${VCFOPS_HOST}/suite-api/api/pricing. Dry run: nothing was changed. Run it without --dry-run to apply."',
        '  exit 0',
        'fi',
        '',
        'if [[ -n "$existing" ]]; then',
        '  api PUT /suite-api/api/pricing -H "Content-Type: application/json" --data-binary @"$WORK/policy.json" >/dev/null',
        '  id="$existing"',
        '  echo "Updated pricing policy ${id}."',
        'else',
        '  id=$(api POST /suite-api/api/pricing -H "Content-Type: application/json" --data-binary @"$WORK/policy.json" | jq -r .id)',
        '  if [[ -z "$id" || "$id" == null ]]; then echo "The API accepted the request but returned no id. Check GET /suite-api/api/pricing before running again." >&2; exit 1; fi',
        '  echo "Created pricing policy ${id}."',
        'fi',
        'echo "${id}" >"$HERE/pricing-policy-id.txt"',
        'api GET "/suite-api/api/pricing/${id}" >"$WORK/readback.json"',
        'if ! diff <(listing "$WORK/policy.json") <(listing "$WORK/readback.json") >&2; then',
        '  echo "The policy reads back with different rates (above). Check it in the interface before it is assigned." >&2',
        '  exit 1',
        'fi',
        'echo "Read back: every rate as sent."',
        'if [[ "${UPFRONT_MANUAL:-0}" == 1 ]]; then',
        '  echo "Upfront pricing: the policy has no single flag for it on this build. Turn on upfront pricing for this policy under Manage → Cost → Pricing (VERIFY the label)." >&2',
        'fi',
        'echo "It prices nothing until it is assigned — see showback-setup.md."',
        '',
        '# Undo: DELETE /suite-api/api/pricing/{id} (the id is in pricing-policy-id.txt), or re-run with the previous rate-card.json.',
        '',
      ].join('\n');

      const assignLine =
        assignTo === 'tag'
          ? `VMs by the vSphere tag category **${tagCategory}**: one tag value per cost centre, priced by this policy. Assign the policy to the tag-based group (or use tag-based rate factors in the policy) under Manage → Cost → Pricing. Cross-check with the tag standard so the category is the same one VCF Automation stamps on new VMs.`
          : `The VCF Automation ${assignTo === 'organization' ? 'organizations' : 'projects'} **${names.join(', ') || '(none)'}**. Under Manage → Cost → Pricing, assign the policy to each; an ${assignTo} with no assignment is priced by the default policy.`;

      const setup = [
        `# ${policyName} — showback and chargeback setup`,
        '',
        `Currency **${currency}**. Showback and bills cover **${serviceLabel[serviceType] ?? serviceType}**.`,
        '',
        '| Rate | Per month | Charged on |',
        '|---|---|---|',
        `| vCPU | ${rVcpu} | ${basis} |`,
        `| Memory, per GB | ${rRam} | ${basis} |`,
        `| Storage, per GB | ${rStorage} | ${basis} |`,
        ...storagePolicyRates.map((row) => `| Storage on “${row.policy}”, per GB | ${row.rate} | ${basis} |`),
        `| Fixed, per VM | ${fixed} | recurring |`,
        ...vksRates.map((row) => `| VKS node, VM class ${row.vmClass} | ${row.rate} | per node |`),
        '',
        'Cost is what it costs you (the cost drivers). Price is what you charge. The gap between them is the',
        'margin or the subsidy, and it should be a decision — compare this card with the per-host cost from',
        '"Cost drivers" before publishing it.',
        '',
        '## 1. The template, once, in the interface',
        '',
        `Manage → Cost → Pricing (VERIFY the path in your build): create a policy with every item you want priced — CPU, memory, storage${storagePolicyRates.length > 0 ? ', each storage policy above' : ''}, a recurring per-VM charge${vksRates.length > 0 ? ', and VKS nodes for each VM class above' : ''} — charged on **${basis}**, monthly. Any non-zero rate. Its id is TEMPLATE_POLICY_ID. There is no API that creates a pricing policy from nothing with the item names the engine expects; after this one, every change is scripted.`,
        '',
        '## 2. Create or update the real policy from it',
        '',
        '`TEMPLATE_POLICY_ID=… ./build-policy.sh` — checks the currency, sets every rate, creates the policy (or updates the one of the same name), and reads it back.',
        upfront
          ? 'It also turns on 9.1 upfront pricing on the policy, so VCF Automation shows requesters the estimated price of a VM or VKS node before they deploy. If the build has no single flag for it, the script says so and the step is: Manage → Cost → Pricing → this policy → show upfront pricing in VCF Automation (VERIFY the label).'
          : 'Upfront pricing in VCF Automation is left off for this policy.',
        '',
        '## 3. Assign it',
        '',
        assignLine,
        'There is no documented API for pricing assignment, so this is the interface step.',
        '',
        '## 4. Service type (9.1)',
        '',
        serviceType === 'all'
          ? 'On the Organization and Project Showback dashboards and on each bill, keep the service-type filter showing regular VMs, VKS and Data Services Manager separately, so a VKS node VM or a DSM VM is not also charged as a regular VM.'
          : `On the Organization and Project Showback dashboards and on each bill, set the service-type filter to **${serviceLabel[serviceType]}**. The filter is a dashboard and bill setting with no API; set it once and save the dashboard.`,
        '',
        ...(appShowback
          ? ['## 5. Application showback (9.1)', '', 'Define the applications and tiers (VCF Operations applications) whose total running cost and charges should be visible, and read them on the showback dashboards with the service-type filter above.', '']
          : []),
        `## ${appShowback ? '6' : '5'}. Bills`,
        '',
        bills
          ? `Manage → Cost → Bills: a **recurring** bill, ${cadence}, per ${assignTo === 'tag' ? 'cost centre' : assignTo}. 9.1 generates the bill as PDF and emails it: send to ${recipients.join(', ') || '(nobody)'}. Generate one bill by hand first and read it. There is no documented API for bills.`
          : 'No bills. Showback dashboards only.',
        '',
        `## ${appShowback ? '7' : '6'}. Tenant reports and alerts (9.1)`,
        '',
        alertPct > 0
          ? `Notification rules for tenants: email the organization when its consumption passes **${alertPct}%** of its quota, and a monthly consumption and cost report. Tenants read these, so send them to a team address in the tenant, not to the platform team.`
          : 'Tenant alerts are off.',
        '',
        '## Undo',
        '',
        'Unassign the policy (the next applicable policy takes over), then DELETE /suite-api/api/pricing/{id} (the id is in',
        'pricing-policy-id.txt). Bills already generated keep the rates they were generated with.',
        '',
      ].join('\n');

      return {
        platform: PLATFORM,
        title: `${policyName} — ${currency} ${rVcpu}/vCPU, ${rRam}/GB RAM, ${rStorage}/GB storage, ${fixed}/VM${vksRates.length > 0 ? `, ${vksRates.length} VKS node class${vksRates.length === 1 ? '' : 'es'}` : ''}, per month`,
        effect: 'reversible',
        trigger: { kind: 'schedule', detail: bills ? `Prices recalculated with the daily cost run; bills generated ${cadence}` : 'Prices recalculated with the daily cost run', worstCase: bills ? `a bill per ${assignTo === 'tag' ? 'cost centre' : assignTo} every ${cadence === 'quarterly' ? 'quarter' : 'month'}` : 'daily recalculation' },
        scope: {
          what: assignTo === 'tag' ? `VMs tagged with a value in ${tagCategory}.` : `Everything in the ${assignTo}s ${names.join(', ') || '(none)'}.`,
          decidedBy: [
            assignTo === 'tag' ? `The vSphere tag category ${tagCategory}, as VCF Operations last collected it.` : `The ${assignTo} assignment made under Pricing.`,
            'Policy precedence: where more than one pricing policy could apply, the more specific assignment wins (VERIFY the order in your release).',
            `The charge basis — ${basis} — set on the template and copied.`,
            `The service-type filter: ${serviceLabel[serviceType] ?? serviceType}.`,
          ],
          ifWrong: `A tenant is billed at the wrong rate, or not at all${upfront ? ', and requesters in VCF Automation are quoted it before they deploy' : ''}. Bills are documents people pay from; a wrong one is corrected by a credit note and an apology, not an undo.`,
        },
        guardrails: [
          { rule: 'Rates are mapped onto the template’s own items, and the script refuses if one does not match', because: 'A rate that matches no item is silently dropped by the API, and the bill comes out cheaper than the card with no error anywhere.' },
          { rule: 'Refuses when the rate card’s currency is not the one the cost engine runs in', because: 'A price in euros read as dollars is wrong on every line, and nothing else would catch it.' },
          { rule: 'A policy with the same name is updated, never duplicated; more than one with the name stops the script', because: 'Two identically named policies is how the wrong one gets assigned.' },
          { rule: 'Reads the policy back and exits 1 if any rate differs from what was sent', because: 'The rates it prints are the review, and the read-back proves they are what the platform holds.' },
        ],
        dryRun: ['Run build-policy.sh --dry-run first and read every item and rate it prints; it sends nothing.', 'Generate one bill by hand for one tenant and check it against the card before the recurring bill is turned on.'],
        undo: ['Unassign the policy, then DELETE /suite-api/api/pricing/{id} with the id in pricing-policy-id.txt — or re-run build-policy.sh with the previous rate-card.json.', 'Bills already sent cannot be recalled.'],
        told: bills ? [`${recipients.join(', ') || 'Nobody'} receives each bill as PDF, ${cadence}.`, ...(alertPct > 0 ? [`Tenants are emailed at ${alertPct}% of quota.`] : []), ...(upfront ? ['Requesters see the upfront price in VCF Automation.'] : [])] : ['Nobody; showback dashboards only.', ...(upfront ? ['Requesters see the upfront price in VCF Automation.'] : [])],
        requires: [
          'A template pricing policy created once in the interface, and its id in TEMPLATE_POLICY_ID.',
          `The currency set to ${currency} — see "Cost drivers and the CPU:memory cost ratio", which sets it.`,
          ...(assignTo === 'tag' ? [`vSphere tags in category ${tagCategory} on the VMs, collected by VCF Operations.`] : ['The VCF Automation integration in VCF Operations, so organizations and projects are visible.']),
          ...(vksRates.length > 0 ? ['VKS collected by VCF Operations (Supervisor and its vSphere Namespaces), so node VMs have a VM class to price by.'] : []),
          ...(bills ? ['An outbound mail plugin configured in VCF Operations.'] : []),
        ],
        files: {
          'rate-card.json': `${JSON.stringify(card, null, 2)}\n`,
          'build-policy.sh': build,
          'showback-setup.md': setup,
          'IMPORT.md': importMd({
            title: `the pricing policy "${policyName}"`,
            intro: ['A pricing policy is not imported from a file: the pricing API documents a policy’s shape but not the item names it expects, so build-policy.sh clones a template policy made once in the interface and sets its rates from rate-card.json.'],
            steps: [
              { heading: 'The template policy', files: ['showback-setup.md'], how: ['Create one pricing policy by hand, as showback-setup.md says. It is the template every generated policy is cloned from.'] },
              { heading: 'The rate card', files: ['rate-card.json', 'build-policy.sh'], how: ['./build-policy.sh checks the currency, clones the template, sets the rates, creates or updates the policy and reads it back; ./build-policy.sh --dry-run only prints what it would send.'], verify: ['the global settings path (GLOBALS_PATH) the currency is read from, and the name of the upfront-pricing flag on a policy.'] },
              { heading: 'Assign it', files: ['showback-setup.md'], how: ['Assign the policy to the organizations, projects or tag as showback-setup.md lists, set the service-type filter, and set up the bills.'] },
            ],
          }),
        },
        notes: [
          'The pricing API is GET/POST/PUT /suite-api/api/pricing and GET/DELETE /suite-api/api/pricing/{id}, as documented for the 8.x releases. VERIFY it against your 9.1 build — the path and the update shape are the likeliest to differ.',
          'There is no documented API for pricing assignment, bills, the service-type filter or tenant notifications, so those are interface steps.',
          'VCF Automation 9.1 shows an upfront price estimate when a VM or a VKS node is requested. It comes from this policy, so a wrong rate is visible to requesters before it is visible on a bill.',
          '9.1 prices VKS per node by VM class; a class the template has no item for is refused by build-policy.sh rather than priced at zero.',
        ],
        findings,
      };
    },
  }),

  // -------------------------------------------------------------------------
  automationBlueprint({
    id: 'vcfops_whatif',
    platform: PLATFORM,
    label: 'What-if scenarios, written down so they can be run again',
    group: 'Capacity',
    description:
      'What-if analysis answers “will it fit, and until when” for adding workloads, adding or removing hosts, vSAN (HCI) workloads and hosts with their storage policy and failures to tolerate, comparing datacenters, or moving to a cloud. The answer is only as good as the inputs, and the inputs usually live in someone’s head. This writes every scenario as a file, the exact steps to enter each, and a read-only baseline of each cluster’s capacity figures on the day, so the results can be checked and the same questions asked again next quarter.',
    inputs: [
      {
        id: 'scenario',
        label: 'Scenario',
        control: 'select',
        options: [
          { value: 'add-workload', label: 'Add workloads' },
          { value: 'hci-workload', label: 'Add workloads on vSAN (HCI)' },
          { value: 'add-hosts', label: 'Add hosts' },
          { value: 'hci-hosts', label: 'Add vSAN (HCI) hosts' },
          { value: 'remove-hosts', label: 'Remove hosts' },
          { value: 'compare-datacenters', label: 'Compare datacenters for a workload' },
          { value: 'migrate-cloud', label: 'Migrate to a cloud' },
        ],
        default: 'add-workload',
      },
      { id: 'scenario_name', label: 'Scenario name', control: 'text', default: 'Q1 ERP expansion' },
      { id: 'cluster', label: 'Cluster', control: 'text', default: 'wld01-cl01' },
      { id: 'vm_count', label: 'VMs', control: 'number', default: 40, min: 1, max: 100000, showWhen: { input: 'scenario', equals: ['add-workload', 'hci-workload', 'compare-datacenters', 'migrate-cloud'] } },
      { id: 'vcpu', label: 'vCPU each', control: 'number', default: 4, min: 1, max: 768, showWhen: { input: 'scenario', equals: ['add-workload', 'hci-workload', 'compare-datacenters', 'migrate-cloud'] } },
      { id: 'mem_gb', label: 'Memory each (GB)', control: 'number', default: 16, min: 1, max: 24576, showWhen: { input: 'scenario', equals: ['add-workload', 'hci-workload', 'compare-datacenters', 'migrate-cloud'] } },
      { id: 'disk_gb', label: 'Disk each (GB)', control: 'number', default: 200, min: 1, max: 65536, showWhen: { input: 'scenario', equals: ['add-workload', 'hci-workload', 'compare-datacenters', 'migrate-cloud'] } },
      { id: 'util_pct', label: 'Expected utilisation (%)', control: 'number', default: 40, min: 1, max: 100, showWhen: { input: 'scenario', equals: ['add-workload', 'hci-workload', 'compare-datacenters', 'migrate-cloud'] } },
      { id: 'storage_policy', label: 'vSAN storage policy', control: 'text', default: 'vSAN Default Storage Policy', showWhen: { input: 'scenario', equals: ['hci-workload', 'hci-hosts'] } },
      {
        id: 'ftt',
        label: 'Failures to tolerate',
        control: 'select',
        options: [
          { value: 'ftt1-raid1', label: '1 failure — RAID-1 (mirroring), 2× raw' },
          { value: 'ftt1-raid5', label: '1 failure — RAID-5 (erasure coding), 1.33× raw' },
          { value: 'ftt2-raid1', label: '2 failures — RAID-1 (mirroring), 3× raw' },
          { value: 'ftt2-raid6', label: '2 failures — RAID-6 (erasure coding), 1.5× raw' },
          { value: 'ftt3-raid1', label: '3 failures — RAID-1 (mirroring), 4× raw' },
          { value: 'ftt0', label: 'No redundancy, 1× raw' },
        ],
        default: 'ftt1-raid5',
        showWhen: { input: 'scenario', equals: ['hci-workload', 'hci-hosts'] },
      },
      { id: 'hosts_delta', label: 'Hosts', control: 'number', default: 2, min: 1, max: 64, showWhen: { input: 'scenario', equals: ['add-hosts', 'hci-hosts', 'remove-hosts'] } },
      { id: 'host_cores', label: 'Cores per new host', control: 'number', default: 64, min: 1, max: 1024, showWhen: { input: 'scenario', equals: ['add-hosts', 'hci-hosts'] } },
      { id: 'host_mem_gb', label: 'Memory per new host (GB)', control: 'number', default: 1024, min: 1, max: 24576, showWhen: { input: 'scenario', equals: ['add-hosts', 'hci-hosts'] } },
      { id: 'host_disk_tb', label: 'vSAN raw capacity per new host (TB)', control: 'number', default: 30, min: 1, max: 1000, showWhen: { input: 'scenario', equals: ['hci-hosts'] } },
      { id: 'compare_targets', label: 'Datacenters to compare', control: 'text', default: 'DC-North, DC-South', showWhen: { input: 'scenario', equals: ['compare-datacenters'] }, hint: 'Datacenters or custom datacenters, as VCF Operations names them. The cost comparison uses each one’s cost drivers' },
      { id: 'cloud', label: 'Cloud', control: 'select', options: [{ value: 'VMware Cloud on AWS', label: 'VMware Cloud on AWS' }, { value: 'Azure VMware Solution', label: 'Azure VMware Solution' }, { value: 'Google Cloud VMware Engine', label: 'Google Cloud VMware Engine' }, { value: 'Native public cloud', label: 'Native public cloud (AWS, Azure, GCP)' }], default: 'VMware Cloud on AWS', showWhen: { input: 'scenario', equals: ['migrate-cloud'] } },
      { id: 'start_date', label: 'Implementation date', control: 'text', default: '2027-01-15' },
      {
        id: 'more_scenarios',
        label: 'More scenarios, saved and run beside it',
        control: 'textarea',
        default: 'Q2 VDI refresh | add-workload | wld02-cl01 | 300 | 2 | 8 | 80 | 0\nQ3 host refresh | add-hosts | wld01-cl01 | 0 | 0 | 0 | 0 | 4',
        hint: 'Name | Type | Cluster | VMs | vCPU | Memory GB | Disk GB | Hosts',
        help: 'Type: add-workload, hci-workload, add-hosts, hci-hosts or remove-hosts. HCI rows use the storage policy and failures to tolerate above; new hosts use the host size above. Leave empty for one scenario.',
      },
      { id: 'min_days', label: 'Baseline fails below (days of capacity remaining)', control: 'number', default: 90, min: 0, max: 3650 },
    ],
    automation: (values: BlueprintValues, name: string): Automation => {
      const scenario = str(values, 'scenario', 'add-workload');
      const scenarioName = str(values, 'scenario_name', 'What-if');
      const cluster = str(values, 'cluster', '');
      const count = num(values, 'vm_count', 40);
      const vcpu = num(values, 'vcpu', 4);
      const mem = num(values, 'mem_gb', 16);
      const disk = num(values, 'disk_gb', 200);
      const util = num(values, 'util_pct', 40);
      const storagePolicy = str(values, 'storage_policy', 'vSAN Default Storage Policy');
      const ftt = str(values, 'ftt', 'ftt1-raid5');
      const hostsDelta = num(values, 'hosts_delta', 2);
      const hostCores = num(values, 'host_cores', 64);
      const hostMem = num(values, 'host_mem_gb', 1024);
      const hostDiskTb = num(values, 'host_disk_tb', 30);
      const compareTargets = listOf(str(values, 'compare_targets', ''));
      const cloud = str(values, 'cloud', 'VMware Cloud on AWS');
      const start = str(values, 'start_date', '');
      const minDays = num(values, 'min_days', 90);
      const base = slugOf(name || scenarioName, 'whatif');

      const FTT: Record<string, { label: string; factor: number; minHosts: number }> = {
        'ftt1-raid1': { label: 'FTT=1, RAID-1', factor: 2, minHosts: 3 },
        'ftt1-raid5': { label: 'FTT=1, RAID-5', factor: 4 / 3, minHosts: 4 },
        'ftt2-raid1': { label: 'FTT=2, RAID-1', factor: 3, minHosts: 5 },
        'ftt2-raid6': { label: 'FTT=2, RAID-6', factor: 1.5, minHosts: 6 },
        'ftt3-raid1': { label: 'FTT=3, RAID-1', factor: 4, minHosts: 7 },
        ftt0: { label: 'FTT=0', factor: 1, minHosts: 1 },
      };
      const protection = FTT[ftt] ?? FTT['ftt1-raid5']!;
      const TYPES = ['add-workload', 'hci-workload', 'add-hosts', 'hci-hosts', 'remove-hosts'];
      const workloadTypes = new Set(['add-workload', 'hci-workload', 'compare-datacenters', 'migrate-cloud']);

      type Scenario = { name: string; type: string; cluster: string; count: number; vcpu: number; mem: number; disk: number; hosts: number };
      const first: Scenario = { name: scenarioName, type: scenario, cluster, count, vcpu, mem, disk, hosts: hostsDelta };
      const extra: Scenario[] = rowsOf(str(values, 'more_scenarios', '')).map(([n = '', type = '', c = '', vms = '', cpu = '', m = '', d = '', h = '']) => ({
        name: n,
        type: type.toLowerCase(),
        cluster: c,
        count: numOr(vms, 0),
        vcpu: numOr(cpu, 0),
        mem: numOr(m, 0),
        disk: numOr(d, 0),
        hosts: numOr(h, 0),
      }));
      const all = [first, ...extra];
      const clusters = [...new Set(all.map((s) => s.cluster).filter(Boolean))];

      const findings: Finding[] = [];
      if (!cluster.trim()) findings.push(error('vcfops.whatif.no-cluster', 'A scenario needs a cluster (or, for migration and comparison, the source) to be measured against.', { source: SRC }));
      all.forEach((s, index) => {
        const where = index === 0 ? '' : ` (scenario “${s.name || `row ${index}`}”)`;
        const isWorkload = workloadTypes.has(s.type);
        const rawTb = (s.count * s.disk * (s.type === 'hci-workload' ? protection.factor : 1)) / 1024;
        if (index > 0) {
          if (!s.name) findings.push(error('vcfops.whatif.row-name', `More scenarios row ${index} has no name.`, { source: SRC }));
          if (!TYPES.includes(s.type)) findings.push(error('vcfops.whatif.row-type', `More scenarios row ${index}: “${s.type}” is not one of ${TYPES.join(', ')}.`, { source: SRC }));
          if (!s.cluster) findings.push(error('vcfops.whatif.row-cluster', `More scenarios row ${index} names no cluster.`, { source: SRC }));
          if (isWorkload && (s.count < 1 || s.vcpu < 1 || s.mem < 1 || s.disk < 1)) findings.push(error('vcfops.whatif.row-workload', `More scenarios row ${index}: a workload scenario needs VMs, vCPU, memory and disk.`, { source: SRC }));
          if (/hosts$/.test(s.type) && s.hosts < 1) findings.push(error('vcfops.whatif.row-hosts', `More scenarios row ${index}: a host scenario needs a number of hosts.`, { source: SRC }));
        }
        if (isWorkload && s.count > 10000) findings.push(error('vcfops.whatif.too-many-vms', `${s.count} VMs${where} is above the 10,000 a 9.1 what-if scenario supports.`, { remediation: 'Split it into scenarios by application or by phase.', source: SRC }));
        if (isWorkload && rawTb > 200) findings.push(error('vcfops.whatif.too-much-storage', `${Math.round(rawTb)} TB${where} is above the 200 TB of storage a 9.1 what-if scenario supports.`, { remediation: 'Split it into scenarios by application or by phase.', source: SRC }));
        if (s.type === 'remove-hosts') {
          findings.push(
            warning('vcfops.whatif.remove', `Removing ${s.hosts} host(s)${where} also removes HA failover capacity if admission control reserves a percentage.`, {
              remediation: 'Check the result against the cluster’s admission control, not only the capacity figure. What-if does not change admission control for you.',
              source: SRC,
            }),
          );
        }
      });
      if (new Set(all.map((s) => s.name)).size !== all.length) findings.push(error('vcfops.whatif.duplicate-name', 'Two scenarios share a name; saved scenarios are told apart by name.', { source: SRC }));
      if (workloadTypes.has(scenario) && util >= 90) findings.push(warning('vcfops.whatif.util', `${util}% expected utilisation is a sizing for peak, not for demand.`, { remediation: 'Use the average you expect. Allocation-model results already cover what was promised.', source: SRC }));
      if (!/^\d{4}-\d{2}-\d{2}$/.test(start)) findings.push(warning('vcfops.whatif.date', 'The implementation date is not a YYYY-MM-DD date, so the steps cannot say when to set it for.', { source: SRC }));
      const usesHci = all.some((s) => s.type.startsWith('hci-'));
      if (usesHci && ftt === 'ftt0') findings.push(warning('vcfops.whatif.ftt0', 'Failures to tolerate 0 models vSAN with no redundancy: one disk or host failure loses data.', { remediation: 'Model the storage policy production VMs will actually get.', source: SRC }));
      if (usesHci && !storagePolicy.trim()) findings.push(error('vcfops.whatif.no-policy', 'An HCI scenario needs the vSAN storage policy the VMs will use.', { source: SRC }));
      if (usesHci && protection.minHosts > 3) findings.push(info('vcfops.whatif.ftt-hosts', `${protection.label} needs at least ${protection.minHosts} hosts in the cluster.`, { remediation: 'The scenario does not check host count against the policy; check the cluster has enough.', source: SRC }));
      if (scenario === 'compare-datacenters' && compareTargets.length < 2) findings.push(error('vcfops.whatif.compare-few', 'A datacenter comparison needs at least two datacenters to compare.', { source: SRC }));

      const typeLabel: Record<string, string> = {
        'add-workload': 'Workload Planning: Traditional (add VMs)',
        'hci-workload': 'Workload Planning: Hyperconverged (add VMs on vSAN)',
        'add-hosts': 'Infrastructure Planning: Traditional (add hosts)',
        'hci-hosts': 'Infrastructure Planning: Hyperconverged (add vSAN hosts)',
        'remove-hosts': 'Infrastructure Planning: Traditional (remove hosts)',
        'compare-datacenters': 'Datacenter Comparison',
        'migrate-cloud': cloud === 'Native public cloud' ? 'Migration Planning: Public Cloud' : 'Migration Planning: VMware Cloud',
      };

      const specOf = (s: Scenario) => {
        const isWorkload = workloadTypes.has(s.type);
        const hci = s.type.startsWith('hci-');
        return {
          name: s.name,
          type: s.type,
          interfaceType: typeLabel[s.type] ?? s.type,
          cluster: s.cluster,
          implementationDate: start,
          ...(isWorkload ? { workload: { vmCount: s.count, vcpuPerVm: s.vcpu, memoryGbPerVm: s.mem, diskGbPerVm: s.disk, expectedUtilisationPct: util, totals: { vcpu: s.count * s.vcpu, memoryGb: s.count * s.mem, diskGb: s.count * s.disk, ...(hci ? { vsanRawGb: Math.round(s.count * s.disk * protection.factor) } : {}) } } } : {}),
          ...(hci ? { vsan: { storagePolicy, failuresToTolerate: protection.label, rawPerUsable: Math.round(protection.factor * 100) / 100 } } : {}),
          ...(s.type === 'add-hosts' || s.type === 'hci-hosts' ? { hosts: { add: s.hosts, coresEach: hostCores, memoryGbEach: hostMem, ...(s.type === 'hci-hosts' ? { vsanRawTbEach: hostDiskTb, usableTbTotal: Math.round(((s.hosts * hostDiskTb) / protection.factor) * 10) / 10 } : {}) } } : {}),
          ...(s.type === 'remove-hosts' ? { hosts: { remove: s.hosts } } : {}),
          ...(s.type === 'compare-datacenters' ? { compare: compareTargets } : {}),
          ...(s.type === 'migrate-cloud' ? { target: cloud } : {}),
        };
      };

      const spec = {
        $comment: 'What-if scenarios. Entered in the interface: VCF Operations 9.1 has no documented API for what-if analysis.',
        scenarios: all.map(specOf),
      };

      const stepsFor = (s: Scenario, index: number): string[] => {
        const isWorkload = workloadTypes.has(s.type);
        const rawTb = Math.round(((s.count * s.disk * (s.type === 'hci-workload' ? protection.factor : 1)) / 1024) * 10) / 10;
        return [
          `## ${index + 1}. ${s.name} — ${typeLabel[s.type] ?? s.type}`,
          '',
          `1. Manage → Capacity → What-If Analysis (VERIFY the path in your build). Choose **${typeLabel[s.type] ?? s.type}**.`,
          `2. Location: **${s.cluster || '(cluster)'}**. Implementation date: **${start || '(date)'}**.`,
          ...(isWorkload ? [`3. Workload: ${s.count} VMs, ${s.vcpu} vCPU, ${s.mem} GB memory, ${s.disk} GB disk each, expected utilisation ${util}%. Totals: ${s.count * s.vcpu} vCPU, ${s.count * s.mem} GB memory, ${rawTb} TB ${s.type === 'hci-workload' ? 'vSAN raw' : 'disk'}.`] : []),
          ...(s.type.startsWith('hci-') ? [`${isWorkload ? '4' : '3'}. vSAN: storage policy **${storagePolicy}**, ${protection.label} (${Math.round(protection.factor * 100) / 100}× raw per usable GB).`] : []),
          ...(s.type === 'add-hosts' || s.type === 'hci-hosts' ? [`4. Add ${s.hosts} host(s), ${hostCores} cores and ${hostMem} GB each${s.type === 'hci-hosts' ? `, ${hostDiskTb} TB vSAN raw each` : ''} — choose the matching server model or enter it as a custom profile.`] : []),
          ...(s.type === 'remove-hosts' ? [`3. Remove ${s.hosts} host(s). Pick the ones you would actually remove, not the smallest.`] : []),
          ...(s.type === 'compare-datacenters' ? [`4. Compare: **${compareTargets.join(', ') || '(none)'}**. The comparison costs the workload with each one’s cost drivers, so review those first.`] : []),
          ...(s.type === 'migrate-cloud' ? [`4. Target: **${cloud}**. Pick the region and instance type you would buy; the cost comparison depends on it.`] : []),
          `5. Save the scenario as **${s.name}**, then run it. Record: fits yes/no, the constraining resource, and time remaining after.`,
          '',
        ];
      };

      const steps = [
        `# What-if: ${all.map((s) => s.name).join('; ')}`,
        '',
        'What-if analysis is read-only: it models, and changes nothing in the inventory. VCF Operations 9.1 has no',
        `documented API for it, so each scenario is entered from \`${base}-scenarios.json\`, which is the record of what was asked.`,
        '',
        '1. Run `baseline.sh` first and keep its output beside this file: what each cluster looked like the day the question was asked.',
        '2. Enter and save each scenario below.',
        `3. Run each alone first, then combine them (select several saved scenarios → Combine) to see them together. Paste the results into \`${base}-result.md\`.`,
        '',
        ...all.flatMap(stepsFor),
      ].join('\n');

      const baseline = readScript('vcf-operations', `Capacity baseline for ${clusters.join(', ') || 'no cluster'}, taken before the what-if scenarios.`, [
        ...POST_QUERY,
        ...LARGE_DATA,
        `CLUSTERS=(${clusters.map((c) => JSON.stringify(c)).join(' ')})`,
        `MIN_DAYS=${minDays}`,
        'short=0',
        'out="baseline-$(date +%Y%m%d).json"',
        'echo \'[]\' >"$out"',
        '',
        'for CLUSTER in "${CLUSTERS[@]}"; do',
        '  id=$(get "/suite-api/api/resources?adapterKind=VMWARE&resourceKind=ClusterComputeResource&name=$(jq -rn --arg n "$CLUSTER" \'$n|@uri\')" |',
        '    jq -r --arg n "$CLUSTER" \'[.resourceList[]? | select(.resourceKey.name == $n)][0].identifier // empty\')',
        '  [[ -n "$id" ]] || { echo "No cluster named ${CLUSTER}." >&2; exit 2; }',
        '  # Capacity keys are discovered rather than assumed: every OnlineCapacityAnalytics',
        '  # stat this cluster reports about time or capacity remaining.',
        '  keys=$(get "/suite-api/api/resources/${id}/statkeys" | jq -c \'[.["stat-key"][]?.key | select(test("^OnlineCapacityAnalytics\\\\|.*(timeRemaining|capacityRemaining|recommendedSize)"; "i"))] | unique\')',
        '  if [[ "$(jq length <<<"$keys")" == 0 ]]; then echo "${CLUSTER} reports no capacity analytics yet." >&2; exit 1; fi',
        '  printf \'%s\\n\' "$keys" >"$WORK/keys.json"',
        '  stats=$(jq -n --arg id "$id" --slurpfile k "$WORK/keys.json" \'{resourceId: [$id], statKey: $k[0], maxSamples: 1}\' |',
        `    post /suite-api/api/resources/stats/latest/query | jq -c --arg id "$id" '(${LATEST_TO_MAP})[$id] // {}')`,
        '  printf \'%s\\n\' "$stats" >"$WORK/stats.json"',
        '  jq --arg c "$CLUSTER" --arg id "$id" --slurpfile s "$WORK/stats.json" \'. + [{cluster: $c, id: $id, taken: (now | todate), stats: $s[0]}]\' "$out" >"$WORK/out.json" && mv "$WORK/out.json" "$out"',
        '  echo "${CLUSTER}:"',
        '  jq -r \'to_entries[] | "  \\(.key)\\t\\(.value)"\' <<<"$stats"',
        '  # A cluster already short answers a question nobody should be asking yet.',
        '  least=$(jq \'[to_entries[] | select(.key | test("timeRemaining"; "i")) | .value | numbers] | min // empty\' <<<"$stats")',
        '  if [[ -n "$least" ]] && (( $(printf "%.0f" "$least") < MIN_DAYS )); then',
        '    echo "${CLUSTER}: least time remaining is ${least} days, under ${MIN_DAYS}. Fix the current shortfall before modelling more." >&2',
        '    short=1',
        '  fi',
        'done',
        'echo "Saved to ${out}."',
        'exit "$short"',
      ]);

      return {
        platform: PLATFORM,
        title: all.length === 1 ? `What-if “${scenarioName}” on ${cluster || 'no cluster'} — ${scenario.replace(/-/g, ' ')}` : `${all.length} what-if scenarios on ${clusters.join(', ') || 'no cluster'}`,
        effect: 'read',
        trigger: { kind: 'manual', detail: 'Run when the question is asked, and again each quarter with the same file.' },
        scope: {
          what: `The capacity model of ${clusters.join(', ') || '(no cluster)'}${scenario === 'compare-datacenters' ? ` and the cost model of ${compareTargets.join(', ')}` : ''}. Nothing in the inventory.`,
          decidedBy: ['The cluster chosen as each scenario’s location.', 'The capacity policy on that cluster — its model, buffer and overcommit decide the answer as much as the scenario does.', ...(usesHci ? [`The vSAN storage policy ${storagePolicy} and ${protection.label}, which multiply every GB asked for.`] : [])],
          ifWrong: 'A scenario run against the wrong cluster or the wrong policy says “fits” and hardware is not bought. Nothing changes until someone acts on the answer.',
        },
        guardrails: [
          { rule: 'Read-only: what-if models and never changes the inventory', because: 'The platform keeps scenarios separate from the estate, so a mistaken scenario costs nothing but the decision made from it.' },
          { rule: 'Baseline saved with the date, for every cluster in any scenario', because: 'An answer with no record of the capacity it started from cannot be checked when the hardware arrives and the numbers disagree.' },
        ],
        dryRun: ['Everything here is a dry run. Run baseline.sh and read what each cluster has today before trusting what the scenario says it will have.'],
        undo: ['Nothing to undo. Delete the saved scenarios in the interface when they are no longer wanted.'],
        told: ['Whoever asked the question, with the result file. baseline.sh exits 1 if any cluster is already under the days-remaining floor.'],
        requires: [`The clusters ${clusters.join(', ') || '(none)'} collected by VCF Operations with at least a few weeks of history — capacity forecasts need it.`, 'jq on the machine that runs baseline.sh.', ...(scenario === 'compare-datacenters' ? ['Cost drivers reviewed for every datacenter compared.'] : [])],
        files: {
          [`${base}-scenarios.json`]: `${JSON.stringify(spec, null, 2)}\n`,
          [`${base}-steps.md`]: steps,
          'baseline.sh': baseline,
        },
        notes: [
          '9.1 raised the what-if limits to 10,000 VMs and 200 TB of storage per scenario. For HCI scenarios the storage figure checked here is the vSAN raw capacity after the storage policy.',
          'The result depends on the capacity policy of the cluster: an allocation-model policy with a 4:1 CPU ratio and a demand-model policy give different answers to the same scenario. Say which one it was in the result file.',
          'There is no documented API for what-if analysis in 9.1, so the scenarios are entered by hand. If one appears in your build’s API reference, the scenario file has everything it would need.',
        ],
        findings,
      };
    },
  }),

  // -------------------------------------------------------------------------
  automationBlueprint({
    id: 'vcfops_reclaim_91',
    platform: PLATFORM,
    label: 'Reclamation in 9.1: Automation Central jobs, orphaned disks, exclusions',
    group: 'Capacity',
    description:
      'The 9.1 reclamation surface in one place: Automation Central jobs for old snapshots, idle and powered-off VMs and rightsizing (with idle and powered-off VMs now includable), created enabled through the API and scoped to a group, with a pre-run check scheduled the day before; tag-based exclusions set on the Reclaim and Rightsize pages (which Broadcom says Automation Central honours too — verified in the job preview), the reclamation dashboard, and orphaned disks, which 9.1 can now delete. The orphaned-disk half is a script: it re-checks every disk against every VM and template in every vCenter you list, by path and by disk UUID, refuses CNS volumes and replicas, quarantines before it deletes, writes the list before it acts, and stops at a cap.',
    inputs: [
      { id: 'mode', label: 'Generate', control: 'select', options: [{ value: 'jobs', label: 'Automation Central jobs, exclusions and a pre-run check' }, { value: 'orphan-quarantine', label: 'Orphaned disks — move to quarantine (reversible)' }, { value: 'orphan-delete', label: 'Orphaned disks — delete from quarantine (irreversible)' }], default: 'jobs' },
      { id: 'group_name', label: 'Jobs act only within group', control: 'text', default: 'Automation — safe to act on', showWhen: { input: 'mode', equals: ['jobs'] } },
      { id: 'exclude_tag', label: 'Exclusion tag (category=value)', control: 'text', default: 'Automation=never', hint: 'From the tag standard. Set in the Reclaim and Rightsize exclusion settings; Broadcom’s 9.1 guidance is that Automation Central honours it too (verify in a job preview)' },
      { id: 'snapshot_age', label: 'Delete snapshots older than (days)', control: 'number', default: 14, min: 1, max: 365, showWhen: { input: 'mode', equals: ['jobs'] } },
      { id: 'include_idle', label: 'Include idle VMs in snapshot and rightsizing jobs', control: 'toggle', default: true, showWhen: { input: 'mode', equals: ['jobs'] } },
      { id: 'include_off', label: 'Include powered-off VMs in snapshot jobs', control: 'toggle', default: true, showWhen: { input: 'mode', equals: ['jobs'] } },
      { id: 'delete_off', label: 'Also delete powered-off VMs', control: 'toggle', default: false, showWhen: { input: 'mode', equals: ['jobs'] } },
      { id: 'downsize', label: 'Downsize oversized VMs', control: 'toggle', default: true, showWhen: { input: 'mode', equals: ['jobs'] } },
      { id: 'upsize', label: 'Scale up undersized VMs', control: 'toggle', default: false, showWhen: { input: 'mode', equals: ['jobs'] } },
      { id: 'min_vm_age', label: 'Exclude VMs younger than (days)', control: 'number', default: 30, min: 0, max: 365, showWhen: { input: 'mode', equals: ['jobs'] } },
      { id: 'max_objects', label: 'Never more than (objects per run)', control: 'number', default: 25, min: 1, max: 1000 },
      { id: 'hold_days', label: 'Keep in quarantine at least (days)', control: 'number', default: 14, min: 1, max: 365, showWhen: { input: 'mode', equals: ['orphan-quarantine', 'orphan-delete'] } },
      { id: 'window', label: 'Jobs run at', control: 'text', default: 'Sunday 02:00', showWhen: { input: 'mode', equals: ['jobs'] } },
    ],
    automation: (values: BlueprintValues, name: string): Automation => {
      const mode = str(values, 'mode', 'jobs');
      const group = str(values, 'group_name', '');
      const excludeTag = str(values, 'exclude_tag', '');
      const snapAge = num(values, 'snapshot_age', 14);
      const includeIdle = bool(values, 'include_idle', true);
      const includeOff = bool(values, 'include_off', true);
      const deleteOff = bool(values, 'delete_off', false);
      const downsize = bool(values, 'downsize', true);
      const upsize = bool(values, 'upsize', false);
      const minAge = num(values, 'min_vm_age', 30);
      const cap = num(values, 'max_objects', 25);
      const hold = num(values, 'hold_days', 14);
      const window = str(values, 'window', 'Sunday 02:00');
      const base = slugOf(name || 'reclaim-91', 'reclaim');

      const findings: Finding[] = [];
      if (!excludeTag.trim()) {
        findings.push(
          error('vcfops.reclaim91.no-exclusion', 'There is no exclusion tag.', {
            remediation: 'Without one, the only way to take a VM out of reclamation at speed is to edit a job while it runs. Use the tag standard’s Automation=never.',
            source: SRC,
          }),
        );
      }
      if (cap > 100) findings.push(warning('vcfops.reclaim91.cap', `A cap of ${cap} per run is high for deletions.`, { remediation: 'Twenty-five is a sensible first number. Raise it after a quarter of runs nobody complained about.', source: SRC }));

      if (mode === 'jobs') {
        if (!group.trim() || /default|all|world/i.test(group)) {
          findings.push(error('vcfops.reclaim91.no-group', 'The jobs are not bounded by a purpose-built group.', { remediation: 'Scope every destructive Automation Central job to a group built with an opt-in tag — see "A custom group to scope automation".', source: SRC }));
        }
        if (upsize) findings.push(warning('vcfops.reclaim91.upsize', 'Scaling up undersized VMs adds resources automatically, which spends capacity and, on hot-add-disabled VMs, reboots them.', { remediation: 'Keep scale-up as a report until the capacity it will consume is budgeted.', source: SRC }));
        if (deleteOff) findings.push(warning('vcfops.reclaim91.delete-off', 'Deleting powered-off VMs removes machines somebody may have turned off on purpose — DR copies, quarterly batch servers.', { remediation: 'Tag those with the exclusion tag first; ninety days powered off is the usual threshold.', source: SRC }));
        if (minAge === 0) findings.push(warning('vcfops.reclaim91.new-vms', 'New VMs are not excluded, so a VM built yesterday can be rightsized on one day of history.', { remediation: 'Exclude VMs younger than 30 days — 9.1 supports exclusion by VM age.', source: SRC }));
      }

      if (mode !== 'jobs') {
        const quarantine = mode === 'orphan-quarantine';
        const listName = quarantine ? 'orphaned-disks.txt' : 'quarantined-disks.txt';
        const header = quarantine ? '# Move orphaned VMDKs into a quarantine folder on the same datastore.' : `# Delete VMDKs that have sat in quarantine for at least ${hold} days.`;
        const script = [
          '#!/usr/bin/env bash',
          header,
          '#',
          '# VCF Operations reports orphaned disks conservatively and its own documentation',
          '# says a disk in use can be listed. So this does not trust the list. Every disk',
          '# is judged again, here, immediately before it is touched, and is refused unless',
          '# every one of these says it is unused:',
          '#   - the files of every VM and template in EVERY vCenter in VCENTERS (file',
          '#     layouts, and every disk backing including its parent chain), compared as',
          '#     whole normalised paths keyed by datastore URL, not by datastore name;',
          '#   - the disk\'s own ddb.uuid against every VM disk\'s backing UUID;',
          '#   - First Class Disks (CNS persistent volumes) on its datastore;',
          '#   - its folder: no unregistered .vmx (a VM this script cannot see) and no',
          '#     vSphere Replication files.',
          '# It refuses to judge at all if any VM is disconnected, inaccessible or orphaned,',
          '# has no file layout, or uses a datastore the account cannot see.',
          '#',
          `# Input: a text file, one "[datastore] path/to/disk.vmdk" per line (default ${listName}),`,
          '# datastore names as the FIRST vCenter in VCENTERS names them.',
          '# It writes the manifest, then acts; with --dry-run it writes the manifest and changes nothing.',
          'set -euo pipefail',
          'shopt -s inherit_errexit',
          '',
          `MODE=${quarantine ? 'quarantine' : 'delete'}`,
          `MAX_OBJECTS=${cap}  # the cap. Change it here, in review, not on the command line.`,
          `HOLD_DAYS=${hold}`,
          'QDIR="_orphan_quarantine"',
          `LIST="${listName}"`,
          'EXECUTE=1',
          'for arg in "$@"; do',
          '  case "$arg" in',
          '    --dry-run) EXECUTE=0 ;;',
          '    -*) echo "Unknown option ${arg}. The only option is --dry-run." >&2; exit 2 ;;',
          '    *) LIST="$arg" ;;',
          '  esac',
          'done',
          '[[ -f "$LIST" ]] || { echo "No ${LIST}. Export the orphaned disks from the Reclaim page and write one [datastore] path per line." >&2; exit 2; }',
          '',
          ': "${VCENTERS:?set VCENTERS to every vCenter whose hosts mount these datastores, space-separated host names; the first is the one the list names datastores in}"',
          ': "${GOVC_USERNAME:?set GOVC_USERNAME to the account (or put <vcenter>.username beside its password file)}"',
          ': "${GOVC_PASSWORD_DIR:?set GOVC_PASSWORD_DIR to a directory holding <vcenter>.password for each vCenter, each mode 600}"',
          'command -v govc >/dev/null || { echo "govc is required" >&2; exit 2; }',
          'command -v jq >/dev/null || { echo "jq is required" >&2; exit 2; }',
          'read -r -a VCS <<<"$VCENTERS"',
          '(( ${#VCS[@]} > 0 )) || { echo "VCENTERS is empty." >&2; exit 2; }',
          'ACT="${VCS[0]}"',
          'for v in "${VCS[@]}"; do',
          '  [[ "$v" =~ ^[A-Za-z0-9._:-]+$ ]] || { echo "VCENTERS entries are host names, not URLs: ${v}" >&2; exit 2; }',
          '  f="${GOVC_PASSWORD_DIR}/${v}.password"',
          '  [[ -f "$f" ]] || { echo "No password file ${f} for vCenter ${v}." >&2; exit 2; }',
          '  [[ "$(stat -c %a "$f")" == 600 ]] || { echo "${f} must be mode 600." >&2; exit 2; }',
          'done',
          '',
          '# govc against one vCenter. The password is read from its file into the',
          '# environment of that one govc process; it is never an argument.',
          'vc() {',
          '  local host="$1"; shift',
          '  local user="$GOVC_USERNAME"',
          '  [[ -f "${GOVC_PASSWORD_DIR}/${host}.username" ]] && user="$(<"${GOVC_PASSWORD_DIR}/${host}.username")"',
          '  GOVC_URL="https://${host}/sdk" GOVC_USERNAME="$user" GOVC_PASSWORD="$(<"${GOVC_PASSWORD_DIR}/${host}.password")" govc "$@"',
          '}',
          'die() { echo "$*" >&2; exit 2; }',
          '',
          'STAMP=$(date +%Y%m%d-%H%M%S)',
          'MANIFEST="orphan-manifest-${STAMP}.tsv"',
          'RESTORE="orphan-restore-${STAMP}.sh"',
          'WORK=$(mktemp -d)',
          'trap \'rm -rf "$WORK"\' EXIT',
          '',
          '# govc object.collect -json prints one object per managed object in current',
          '# releases ({obj, changeSet:[{name, val}]}) and ObjectContent arrays',
          '# ({Obj, PropSet:[{Name, Val}]}) in older ones; both become {id, name, p}.',
          '# Paths are compared as <datastore URL>/<path>, with // and ./ removed and ..',
          '# resolved, and the top folder of a vSAN or vVols datastore mapped to one name',
          '# whether it was written as the namespace UUID or its friendly name.',
          'cat >"$WORK/lib.jq" <<\'JQ\'',
          'def unwrap: if type == "object" and has("_value") then ._value else . end;',
          'def objects_of: [ .[] | if type == "array" then .[] else . end | select(type == "object") ]',
          '  | map({ id: ((.obj // .Obj // {}) | "\\(.type // .Type):\\(.value // .Value)"),',
          '          p: ([ (.changeSet // .PropSet // .propSet // [])[] | {key: (.name // .Name), value: ((.val // .Val) | unwrap)} ] | from_entries) })',
          '  | map(.name = (.p.name // .id));',
          'def segs: split("/") | map(select(. != "" and . != "."))',
          '  | reduce .[] as $s ([]; if $s == ".." then (if length > 0 then .[:-1] else . end) else . + [$s] end);',
          'def canon($url; $rel; $alias): ($rel | segs) as $s | ($url | sub("/+$"; "")) as $u',
          '  | (if ($s | length) > 0 and (($alias[$u] // {})[$s[0]] != null) then [$alias[$u][$s[0]]] + $s[1:] else $s end) as $t',
          '  | $u + "/" + ($t | join("/"));',
          'def dspath: [capture("^\\\\[(?<ds>[^\\\\]]*)\\\\] ?(?<rel>.*)$")] | first // null;',
          'def forms($p; $dsmap; $alias): ($p | dspath) as $c',
          '  | if $c == null then "UNPARSED\\t" + $p',
          '    elif $c.ds == "" then empty',
          '    elif (($dsmap[$c.ds] // []) | length) == 0 then "NODS\\t" + $p',
          '    else $dsmap[$c.ds][] as $url | canon($url; $c.rel; $alias) end;',
          'def layout: [ (.p["layoutEx.file"] // null) | .. | objects | (.name // .Name // empty) | strings ];',
          'def devkeys($k): [ (.p["config.hardware.device"] // null) | .. | objects | to_entries[] | select(.key | ascii_downcase == $k) | .value | strings ];',
          'def hexid: ascii_downcase | gsub("[^0-9a-f]"; "");',
          'JQ',
          'lib=$(<"$WORK/lib.jq")',
          '',
          'is_ns_type() { [[ "${1,,}" == vsan* || "${1,,}" == vvol* ]]; }',
          '',
          '# Take everything the verdict depends on, from every vCenter, into directory $1.',
          'snapshot() {',
          '  local D="$1" i v',
          '  mkdir -p "$D"',
          '  : >"$D/attached"; : >"$D/uuids"; : >"$D/vcuuids"; echo \'{}\' >"$D/alias.json"',
          '  for i in "${!VCS[@]}"; do',
          '    v="${VCS[$i]}"',
          '    vc "$v" about -json >"$D/about.$i" || die "Could not reach vCenter ${v}; refusing to judge anything orphaned."',
          '    jq -r \'(.about // .About // {}) | (.instanceUuid // .InstanceUuid // empty) | ascii_downcase\' "$D/about.$i" >>"$D/vcuuids"',
          '    vc "$v" object.collect -json -type s / name summary.url summary.type >"$D/ds.$i" || die "Could not list datastores in ${v}."',
          '    jq -s -c "$lib"\' objects_of | map(select((.id | startswith("Datastore:")) and (.p["summary.url"] | type) == "string")) | reduce .[] as $d ({}; .[$d.p.name] += [$d.p["summary.url"]])\' "$D/ds.$i" >"$D/dsmap.$i.json"',
          '    jq -s -r "$lib"\' objects_of[] | select(.id | startswith("Datastore:")) | [.p.name, .p["summary.url"], (.p["summary.type"] // "")] | @tsv\' "$D/ds.$i" >"$D/dsrows.$i"',
          '    # vSAN and vVols: pair each top-level namespace UUID with its friendly name.',
          '    while IFS=$\'\\t\' read -r name url type; do',
          '      is_ns_type "$type" || continue',
          '      vc "$v" datastore.ls -ds "$name" -json >"$D/root.json" || die "Could not list the top level of ${type} datastore ${name} in ${v}."',
          '      jq -c --slurpfile a "$D/alias.json" --arg u "${url%/}" \\',
          '        \'($a[0]) as $a | $a + {($u): (($a[$u] // {}) + ([.[]?.file[]? | select((.friendlyName // "") != "" and .friendlyName != .path) | {(.friendlyName): .path, (.path): .path}] | add // {}))}\' \\',
          '        "$D/root.json" >"$D/alias.new" && mv "$D/alias.new" "$D/alias.json"',
          '    done <"$D/dsrows.$i"',
          '  done',
          '  for i in "${!VCS[@]}"; do',
          '    v="${VCS[$i]}"',
          '    vc "$v" object.collect -json -type m / name config.template runtime.connectionState layoutEx.file config.hardware.device >"$D/vm.$i" \\',
          '      || die "Could not read VM file layouts from ${v}; refusing to judge anything orphaned."',
          '    jq -s -c "$lib"\' objects_of | map(select(.id | startswith("VirtualMachine:")))',
          '      | {count: length,',
          '         notConnected: [.[] | select(.p["runtime.connectionState"] != "connected") | "\\(.name) (\\(.p["runtime.connectionState"] // "state unknown"))"],',
          '         noLayout: [.[] | select(layout | length == 0) | .name]}\' "$D/vm.$i" >"$D/vmcheck.$i"',
          '    local count; count=$(jq .count "$D/vmcheck.$i")',
          '    (( count > 0 )) || die "vCenter ${v} returned no VMs or templates. An account that sees nothing makes every disk look orphaned; refusing. It needs read-only at the vCenter root, propagated."',
          '    if [[ "$(jq \'.notConnected | length\' "$D/vmcheck.$i")" != 0 ]]; then',
          '      echo "vCenter ${v} has VMs that are not connected, so their disks cannot be seen:" >&2',
          '      jq -r \'.notConnected[] | "  " + .\' "$D/vmcheck.$i" >&2',
          '      die "Refusing to judge anything orphaned until every VM is connected (or unregistered on purpose)."',
          '    fi',
          '    if [[ "$(jq \'.noLayout | length\' "$D/vmcheck.$i")" != 0 ]]; then',
          '      echo "vCenter ${v} returned no file layout for these VMs:" >&2',
          '      jq -r \'.noLayout[] | "  " + .\' "$D/vmcheck.$i" >&2',
          '      die "Refusing: a VM whose files cannot be read cannot be shown not to use a disk."',
          '    fi',
          '    jq -s -r --slurpfile m "$D/dsmap.$i.json" --slurpfile a "$D/alias.json" "$lib"\' ($m[0]) as $m | ($a[0]) as $a',
          '      | objects_of | map(select(.id | startswith("VirtualMachine:")))[] | (layout + devkeys("filename"))[] as $f | forms($f; $m; $a)\' \\',
          '      "$D/vm.$i" >>"$D/attached"',
          '    jq -s -r "$lib"\' objects_of | map(select(.id | startswith("VirtualMachine:")))[] | devkeys("uuid")[] | hexid | select(length == 32)\' \\',
          '      "$D/vm.$i" >>"$D/uuids"',
          '    echo "vCenter ${v}: ${count} VMs and templates, all connected, all with file layouts." >&2',
          '  done',
          '  if grep -q $\'^\\(UNPARSED\\|NODS\\)\\t\' "$D/attached"; then',
          '    echo "VM files on datastores this account cannot see, or paths that could not be read:" >&2',
          '    grep $\'^\\(UNPARSED\\|NODS\\)\\t\' "$D/attached" | sort -u | head -20 >&2',
          '    die "Refusing: the account needs read-only on every datastore, from the vCenter root, propagated."',
          '  fi',
          '  sort -u -o "$D/attached" "$D/attached"',
          '  sort -u -o "$D/uuids" "$D/uuids"',
          '}',
          '',
          '# The canonical form of "[ds] rel" in the acting vCenter, or empty.',
          'canon_of() {',
          '  jq -n -r --slurpfile m "$1/dsmap.0.json" --slurpfile a "$1/alias.json" --arg p "[$2] $3" \\',
          '    "$lib"\' ($m[0]) as $m | ($a[0]) as $a | forms($p; $m; $a) | select(startswith("NODS") or startswith("UNPARSED") | not)\'',
          '}',
          '',
          '# First Class Disks on one datastore, as canonical paths. Once per datastore per snapshot; a failure stops the run.',
          'fcd_list() {',
          '  local D="$1" ds="$2" f',
          '  f="$D/fcd.$(printf %s "$ds" | md5sum | cut -c1-16)"',
          '  if [[ ! -f "$f" ]]; then',
          '    vc "$ACT" disk.ls -ds "$ds" -L >"$f.raw" || die "govc disk.ls failed on ${ds}; cannot rule out First Class Disks, refusing."',
          '    # -L prints "<id>  <path>"; the id has no spaces, the path may.',
          '    sed -E \'s/^[^[:space:]]+[[:space:]]+//\' "$f.raw" >"$f.paths"',
          '    jq -R -r --slurpfile m "$D/dsmap.0.json" --slurpfile a "$D/alias.json" "$lib"\' ($m[0]) as $m | ($a[0]) as $a | select(length > 0) | forms(.; $m; $a)\' "$f.paths" >"$f"',
          '  fi',
          '  printf %s "$f"',
          '}',
          '',
          '# Does a vCenter that is not in VCENTERS run HA on this datastore? Its heartbeat',
          '# folder names that vCenter\'s instance UUID. Best effort: absent folder = no evidence.',
          'foreign_ha() {',
          '  local D="$1" ds="$2" u',
          '  vc "$ACT" datastore.ls -ds "$ds" .vSphere-HA >"$WORK/ha" 2>/dev/null || return 1',
          '  while IFS= read -r u; do',
          '    [[ -n "$u" ]] || continue',
          '    grep -qxF -- "$u" "$D/vcuuids" || { echo "$u"; return 0; }',
          '  done < <(grep -oiE \'^FDM-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\' "$WORK/ha" | cut -c5- | tr \'A-F\' \'a-f\')',
          '  return 1',
          '}',
          '',
          '# The verdict for one disk against snapshot $1: "ok", or "skip: why".',
          'judge() {',
          '  local D="$1" ds="$2" rel="$3" c url type dir base u f',
          '  case "$rel" in',
          '    *$\'\\t\'* | *$\'\\r\'*) echo "skip: control character in the path"; return ;;',
          '  esac',
          '  if [[ "$rel" == /* || "$rel" == ./* || "$rel" == *//* || "$rel" == */./* || "$rel" =~ (^|/)\\.\\.(/|$) ]]; then',
          '    echo "skip: not a canonical path (//, ./, .. or a leading /) — write it as the datastore browser shows it"; return',
          '  fi',
          '  base="${rel##*/}"',
          '  if [[ "$rel" == */* ]]; then dir="${rel%/*}"; else dir=""; fi',
          '  shopt -s nocasematch',
          '  if [[ "$rel" =~ (^|/)\\. ]]; then echo "skip: hidden system folder"; shopt -u nocasematch; return; fi',
          '  if [[ "$rel" =~ ^(fcd|catalog|contentlib-[^/]*)/ || "$rel" == */fcd/* ]]; then echo "skip: First Class Disk or content library folder"; shopt -u nocasematch; return; fi',
          '  if [[ "$rel" =~ (^|/)hbr ]]; then echo "skip: vSphere Replication file or folder"; shopt -u nocasematch; return; fi',
          '  if [[ "$base" =~ -(flat|delta|ctk|sesparse|rdm|rdmp|digest)\\.vmdk$ ]]; then echo "skip: an extent, change-tracking, RDM or digest file — list the descriptor, never this"; shopt -u nocasematch; return; fi',
          '  shopt -u nocasematch',
          '  if [[ "$MODE" == quarantine ]]; then',
          '    [[ "$rel" == "$QDIR"/* ]] && { echo "skip: already in quarantine"; return; }',
          '  else',
          '    if [[ ! "$rel" =~ ^_orphan_quarantine/([0-9]{8})-([0-9]{6})/([^/]+\\.vmdk)$ ]]; then',
          '      echo "skip: not exactly ${QDIR}/<YYYYmmdd-HHMMSS>/<name>.vmdk — only quarantined disks may be deleted"; return',
          '    fi',
          '    local qd="${BASH_REMATCH[1]}" qdate',
          '    qdate=$(date -d "$qd" +%s 2>/dev/null) || { echo "skip: ${qd} is not a date"; return; }',
          '    (( ( $(date +%s) - qdate ) / 86400 >= HOLD_DAYS )) || { echo "skip: in quarantine for less than ${HOLD_DAYS} days"; return; }',
          '  fi',
          '  # The datastore, as the acting vCenter knows it: exactly one.',
          '  local n; n=$(jq -r --arg d "$ds" \'(.[$d] // []) | length\' "$D/dsmap.0.json")',
          '  (( n == 1 )) || { echo "skip: datastore ${ds} is not exactly one datastore in ${ACT} (found ${n})"; return; }',
          '  url=$(jq -r --arg d "$ds" \'.[$d][0]\' "$D/dsmap.0.json")',
          '  type=$(awk -F\'\\t\' -v d="$ds" \'$1 == d { print $3; exit }\' "$D/dsrows.0")',
          '  if is_ns_type "$type"; then',
          '    local top="${rel%%/*}"',
          '    jq -e --arg u "${url%/}" --arg t "$top" \'(.[$u] // {})[$t] != null\' "$D/alias.json" >/dev/null \\',
          '      || { echo "skip: ${type} datastore, and the namespace ${top} could not be resolved to both its UUID and friendly name, so a path match cannot be trusted"; return; }',
          '  fi',
          '  if u=$(foreign_ha "$D" "$ds"); then echo "skip: vSphere HA from a vCenter not in VCENTERS (instance ${u}) uses this datastore"; return; fi',
          '  c=$(canon_of "$D" "$ds" "$rel")',
          '  [[ -n "$c" ]] || { echo "skip: path could not be normalised"; return; }',
          '  grep -qxF -- "$c" "$D/attached" && { echo "skip: a VM or template refers to it"; return; }',
          '  vc "$ACT" datastore.ls -ds "$ds" "$rel" >/dev/null 2>&1 || { echo "skip: not found on the datastore"; return; }',
          '  f=$(fcd_list "$D" "$ds")',
          '  grep -qxF -- "$c" "$f" && { echo "skip: registered as a First Class Disk"; return; }',
          '  # The folder it sits in: an unregistered .vmx is a VM this script cannot see.',
          '  if ! vc "$ACT" datastore.ls -ds "$ds" -json "${dir:-.}" >"$WORK/dir.json" 2>/dev/null; then',
          '    echo "skip: could not list its folder"; return',
          '  fi',
          '  if jq -e \'[.[]?.file[]?.path | select(test("^hbr(grp|disk|cfg)\\\\."; "i"))] | length > 0\' "$WORK/dir.json" >/dev/null; then',
          '    echo "skip: vSphere Replication files in the folder — a replica, not an orphan"; return',
          '  fi',
          '  local vmx',
          '  while IFS= read -r vmx; do',
          '    local cv; cv=$(canon_of "$D" "$ds" "${dir:+$dir/}$vmx")',
          '    grep -qxF -- "$cv" "$D/attached" || { echo "skip: ${vmx} in the same folder is not registered in any vCenter in VCENTERS — a VM this script cannot see may use it"; return; }',
          '  done < <(jq -r \'.[]?.file[]?.path | select(test("\\\\.vmx$"; "i"))\' "$WORK/dir.json")',
          '  # The disk\'s own UUID, from its descriptor (the last 64 KiB, so a binary disk is not downloaded).',
          '  vc "$ACT" datastore.tail -c 65536 -ds "$ds" "$rel" >"$WORK/desc" 2>/dev/null || { echo "skip: could not read the descriptor"; return; }',
          '  u=$(grep -aiE \'^[[:space:]]*ddb\\.uuid[[:space:]]*=\' "$WORK/desc" | head -n1 | cut -d= -f2- | tr \'A-F\' \'a-f\' | tr -cd \'0-9a-f\' || true)',
          '  [[ ${#u} == 32 ]] || { echo "skip: no ddb.uuid in the descriptor, so it cannot be matched by UUID"; return; }',
          '  grep -qxF -- "$u" "$D/uuids" && { echo "skip: a VM disk has the same UUID (${u})"; return; }',
          '  echo ok',
          '}',
          '',
          'echo "Reading every VM and template from: ${VCS[*]}" >&2',
          'snapshot "$WORK/s1"',
          '',
          'printf "datastore\\tpath\\tverdict\\n" >"$MANIFEST"',
          'eligible=()',
          'declare -A dests=()',
          'while IFS= read -r line || [[ -n "$line" ]]; do',
          '  [[ -z "$line" || "$line" == \\#* ]] && continue',
          '  if [[ ! "$line" =~ ^\\[([^]]+)\\]\\ (.+\\.vmdk)$ ]]; then',
          '    printf "?\\t%s\\tskip: not a [datastore] path.vmdk line\\n" "${line//$\'\\t\'/ }" >>"$MANIFEST"; continue',
          '  fi',
          '  ds="${BASH_REMATCH[1]}"; rel="${BASH_REMATCH[2]}"',
          '  verdict=$(judge "$WORK/s1" "$ds" "$rel")',
          '  if [[ "$verdict" == ok && "$MODE" == quarantine ]]; then',
          '    dest="${QDIR}/${STAMP}/$(printf %s "$rel" | tr / _)"',
          '    if [[ -n "${dests[$ds$\'\\t\'$dest]:-}" ]]; then verdict="skip: another disk in this run flattens to the same quarantine name"; fi',
          '    dests[$ds$\'\\t\'$dest]=1',
          '  fi',
          '  if [[ "$verdict" == ok ]]; then',
          '    if (( ${#eligible[@]} >= MAX_OBJECTS )); then',
          '      verdict="skip: over the cap of ${MAX_OBJECTS}; next run"',
          '    else',
          '      verdict="$MODE"',
          '      eligible+=("${ds}"$\'\\t\'"${rel}")',
          '    fi',
          '  fi',
          '  printf "%s\\t%s\\t%s\\n" "$ds" "${rel//$\'\\t\'/ }" "$verdict" >>"$MANIFEST"',
          'done <"$LIST"',
          '',
          'echo "Manifest written to ${MANIFEST}: ${#eligible[@]} disk(s) eligible, cap ${MAX_OBJECTS}."',
          'column -t -s $\'\\t\' "$MANIFEST" 2>/dev/null || cat "$MANIFEST"',
          '',
          'if (( ! EXECUTE )); then',
          '  echo "Dry run: nothing was changed. Read the manifest in full, then run it without --dry-run to apply."',
          '  exit 0',
          'fi',
          '(( ${#eligible[@]} > 0 )) || { echo "Nothing eligible."; exit 0; }',
          '',
          '# Judge again, from a fresh read of every vCenter, immediately before acting.',
          'echo "Re-reading every vCenter before acting." >&2',
          'snapshot "$WORK/s2"',
          'LOG="orphan-${MODE}-${STAMP}.log"',
          'if [[ "$MODE" == quarantine ]]; then',
          '  {',
          '    echo "#!/usr/bin/env bash"',
          '    echo "# Put back the disks moved by run ${STAMP}. Needs GOVC_USERNAME and GOVC_PASSWORD_DIR as for the run."',
          '    echo "set -euo pipefail"',
          '    echo \': "${GOVC_USERNAME:?set GOVC_USERNAME}" "${GOVC_PASSWORD_DIR:?set GOVC_PASSWORD_DIR}"\'',
          '    printf \'ACT=%q\\n\' "$ACT"',
          '    declare -f vc',
          '  } >"$RESTORE"',
          '  chmod +x "$RESTORE"',
          'fi',
          'for entry in "${eligible[@]}"; do',
          '  ds="${entry%%$\'\\t\'*}"; rel="${entry#*$\'\\t\'}"',
          '  verdict=$(judge "$WORK/s2" "$ds" "$rel")',
          '  if [[ "$verdict" != ok ]]; then',
          '    echo "$(date -u +%FT%TZ) left [${ds}] ${rel}: ${verdict} on the second check" | tee -a "$LOG"',
          '    continue',
          '  fi',
          '  if [[ "$MODE" == quarantine ]]; then',
          '    dest="${QDIR}/${STAMP}/$(printf %s "$rel" | tr / _)"',
          '    if ! vc "$ACT" datastore.ls -ds "$ds" "$QDIR" >/dev/null 2>&1; then',
          '      type=$(awk -F\'\\t\' -v d="$ds" \'$1 == d { print $3; exit }\' "$WORK/s2/dsrows.0")',
          '      if is_ns_type "$type"; then',
          '        # vSAN and vVols take a top-level folder only as a namespace. VERIFY with your govc and release.',
          '        vc "$ACT" datastore.mkdir -ds "$ds" -namespace "$QDIR" >/dev/null',
          '      else',
          '        vc "$ACT" datastore.mkdir -ds "$ds" -p "$QDIR"',
          '      fi',
          '    fi',
          '    vc "$ACT" datastore.mkdir -ds "$ds" -p "${QDIR}/${STAMP}"',
          '    if vc "$ACT" datastore.ls -ds "$ds" "$dest" >/dev/null 2>&1; then',
          '      echo "$(date -u +%FT%TZ) left [${ds}] ${rel}: ${dest} already exists" | tee -a "$LOG"',
          '      continue',
          '    fi',
          '    vc "$ACT" datastore.mv -ds "$ds" "$rel" "$dest"',
          '    printf \'vc "$ACT" datastore.mv -ds %q %q %q\\n\' "$ds" "$dest" "$rel" >>"$RESTORE"',
          '    echo "$(date -u +%FT%TZ) moved [${ds}] ${rel} -> ${dest}" | tee -a "$LOG"',
          '  else',
          '    vc "$ACT" datastore.rm -ds "$ds" "$rel"',
          '    echo "$(date -u +%FT%TZ) deleted [${ds}] ${rel}" | tee -a "$LOG"',
          '  fi',
          'done',
          'if [[ "$MODE" == quarantine ]]; then',
          '  echo "Done. ${RESTORE} moves them back; ${LOG} is the record. After ${HOLD_DAYS} days, list the quarantined paths and run the delete script."',
          'else',
          '  echo "Done. The log is ${LOG}; the manifest is ${MANIFEST}."',
          'fi',
          '',
        ].join('\n');

        const listTemplate = [
          `# ${quarantine ? 'Orphaned disks to quarantine' : 'Quarantined disks to delete'} — one per line, as "[datastore] path/to/disk.vmdk".`,
          '# Datastore names as the FIRST vCenter in VCENTERS names them. Paths exactly as the datastore browser shows them:',
          '# no //, ./ or .., and the descriptor (name.vmdk), never -flat, -delta, -ctk, -sesparse, -rdm(p) or -digest.',
          quarantine
            ? '# From the Reclaim page → Orphaned Disks → Export All. Copy the datastore and path columns (VERIFY the column names in your export).'
            : '# From the log of a quarantine run, or: govc datastore.ls -ds <datastore> -R _orphan_quarantine. Exactly _orphan_quarantine/<YYYYmmdd-HHMMSS>/<name>.vmdk.',
          quarantine ? '# [vsan-wld01] old-vm-01/old-vm-01_1.vmdk' : '# [vsan-wld01] _orphan_quarantine/20270101-020000/old-vm-01_old-vm-01_1.vmdk',
          '',
        ].join('\n');

        return {
          platform: PLATFORM,
          title: quarantine ? `Quarantine up to ${cap} orphaned disks per run, re-checked against every vCenter` : `Delete up to ${cap} quarantined orphaned disks, after ${hold} days, re-checked first`,
          effect: quarantine ? 'reversible' : 'irreversible',
          trigger: { kind: 'manual', detail: quarantine ? 'Run by hand after exporting the Reclaim page’s orphaned disk list.' : `Run by hand at least ${hold} days after a quarantine run.`, worstCase: `${cap} disks per run` },
          scope: {
            what: quarantine
              ? 'VMDK descriptors in the input list that no VM or template in any listed vCenter refers to by path or by disk UUID, that are not First Class Disks, replicas or system files, and that still exist.'
              : `VMDK descriptors in the input list at exactly _orphan_quarantine/<date>/<name>.vmdk, quarantined ${hold} or more days ago, that still pass every in-use check.`,
            decidedBy: [
              'The input list, from the VCF Operations Reclaim page export.',
              'Every vCenter in VCENTERS: the file layout and every disk backing (with its parent chain and UUID) of every VM and template, read at the start of the run and again immediately before acting.',
              'Paths compared whole, after normalising, keyed by datastore URL — so a shared datastore named differently in two vCenters still matches.',
              'The disk’s own ddb.uuid from its descriptor, against every VM disk’s backing UUID.',
              'govc disk.ls -L on the datastore (First Class Disks / CNS volumes), and the fcd/, catalog/ and contentlib-*/ folder rules.',
              'Its folder: a .vmx no listed vCenter has registered, or vSphere Replication (hbr*) files, refuse it. On a vSAN or vVols datastore, the top folder must resolve to both its UUID and friendly name.',
              ...(quarantine ? [] : [`The quarantine date in the path, which must be ${hold} or more days ago.`]),
              `The cap: at most ${cap} per run.`,
            ],
            ifWrong: quarantine
              ? 'A disk in use by something no listed vCenter knows about — a VM on a vCenter left out of VCENTERS, a standalone host, a backup appliance’s hot-added disk — is moved away. It can be moved back with the restore script; whatever used it fails until then.'
              : 'A disk somebody needed is gone. The hold period is the time they had to notice it was missing.',
          },
          guardrails: [
            { rule: 'Every disk is judged against every VM and template in every vCenter in VCENTERS — by whole normalised path and by disk UUID — at the start and again immediately before it is moved or deleted', because: 'VCF Operations lists orphaned disks conservatively and says a disk in use can appear. A grep of raw JSON missed paths with & < > in them, and one vCenter missed VMs on another that share the datastore.' },
            { rule: 'Refuses to judge anything if a vCenter returns no VMs, or any VM is disconnected, inaccessible or orphaned, has no file layout, or uses a datastore the account cannot see', because: 'An account that sees nothing, or a VM whose files cannot be read, makes every disk look orphaned.' },
            { rule: 'Refuses paths with //, ./ or .., and in delete mode anything that is not exactly _orphan_quarantine/<YYYYmmdd-HHMMSS>/<name>.vmdk', because: 'A path like _orphan_quarantine/<date>/../../app01/app01.vmdk passed a prefix check and deleted a live disk.' },
            { rule: 'First Class Disks (govc disk.ls -L, compared by full path; fcd/, catalog/, contentlib-*/) are refused, and a disk.ls failure stops the run', because: 'A detached CNS persistent volume looks orphaned and is somebody’s database. Kubernetes owns it, not this script.' },
            { rule: 'Refuses extents and sidecars (-flat, -delta, -ctk, -sesparse, -rdm, -rdmp, -digest), hidden folders, vSphere Replication (hbr*) files and folders, and a folder holding a .vmx no listed vCenter has registered', because: 'Those are parts of a disk, a replica, or a VM this script cannot see — not orphans.' },
            { rule: 'Refuses a datastore whose vSphere HA heartbeat folder names a vCenter not in VCENTERS (best effort)', because: 'That is the one on-disk sign that another vCenter’s hosts mount it; a disk they use looks orphaned from here.' },
            { rule: `At most ${cap} per run, enforced by the script`, because: 'A wrong list with a cap is an afternoon of moving files back; without one it is a datastore.' },
            { rule: 'The manifest is written before anything acts; --dry-run stops there', because: 'The export before acting is what the change record points to, and a --dry-run first is where a wrong list is visible.' },
            ...(quarantine
              ? [{ rule: 'Moved, not deleted, with a generated restore script', because: 'The first time an orphaned disk turns out to be in use, moving it back is a command rather than a restore from backup.' }]
              : [{ rule: `Only disks in quarantine for ${hold}+ days can be deleted`, because: 'The path carries the date it was quarantined; anything newer, not a real date, or outside quarantine, is refused. Deletion is never the first thing that happens to a disk.' }]),
            { rule: 'Each vCenter password comes from its own mode-600 file, checked, and reaches govc through its environment, never its arguments', because: 'The script refuses a readable password file rather than running with one.' },
          ],
          dryRun: ['Run it with --dry-run first. It writes the manifest with a verdict for every line and changes nothing.', 'Read every “quarantine”/“delete” line. Anything you cannot name the origin of, exclude from the list.'],
          undo: quarantine
            ? ['Run the orphan-restore-<stamp>.sh the run wrote (same GOVC_USERNAME and GOVC_PASSWORD_DIR): it moves each disk back to where it was.']
            : ['A deleted VMDK cannot be restored except from a datastore-level backup or array snapshot. That is why deletion only happens from quarantine.'],
          told: [`The manifest, the ${quarantine ? 'restore script and move log' : 'deletion log'} (including any disk left alone on the second check), written beside the script. Attach them to the change.`],
          requires: [
            'govc and jq (1.6 or later).',
            'VCENTERS: every vCenter whose hosts mount these datastores, space-separated host names, the one the list’s datastore names come from first. A vCenter left out is a vCenter whose VMs this cannot see — the HA-folder and unregistered-.vmx checks catch some of that, not all.',
            'GOVC_PASSWORD_DIR holding <vcenter>.password for each (mode 600), and optionally <vcenter>.username; otherwise GOVC_USERNAME is used for all.',
            'An account with read-only at each vCenter root, propagated to every VM, template and datastore — an account that cannot see a VM cannot tell that the VM uses a disk — plus Datastore → Browse datastore and Low level file operations on the datastores it acts on.',
            'The orphaned disk list exported from Manage → Capacity → Reclaim → Orphaned Disks.',
          ],
          files: {
            'orphan-disks.sh': script,
            [quarantine ? 'orphaned-disks.txt' : 'quarantined-disks.txt']: listTemplate,
          },
          notes: [
            '9.1 can delete orphaned disks from the Reclaim page itself, behind a confirmation dialog. That deletes directly, with no quarantine and no cap — this script is the slower path with both. Parts of the 9.1 docs still say orphaned disks are only exported; VERIFY which your build does.',
            'govc datastore.mv and datastore.rm on a .vmdk use the virtual disk manager, so the descriptor and its -flat file move together. VERIFY on one disk first with your govc version.',
            'vSAN and vVols: the quarantine folder is created with govc datastore.mkdir -namespace, because a plain top-level folder cannot be created there, and a disk is only judged when the datastore browser returns both the namespace UUID and its friendly name (FileInfo.friendlyName) for its top folder — otherwise it is refused. VERIFY both on one disk with your govc and vSAN release.',
            'The HA check reads .vSphere-HA/FDM-<vCenter instance UUID>-… folder names. VERIFY the naming on one heartbeat datastore; an absent folder is treated as no evidence, not as proof.',
            'A disk whose descriptor has no ddb.uuid cannot be matched by UUID and is refused. That includes some imported disks — move those by hand after checking.',
            'Automation Central has no orphaned-disk job, which is why this is a script and not a schedule.',
          ],
          findings,
        };
      }

      // ---- mode === 'jobs'
      const jobs: { name: string; action: string; interfaceAction: string; params: Record<string, string | number | boolean>; summary: string; deletes: boolean }[] = [
        { name: 'Delete old snapshots', action: 'DELETE_OLD_SNAPSHOTS', interfaceAction: 'Reclaim → Delete old snapshots', params: { olderThanDays: snapAge, includeIdleVms: includeIdle, includePoweredOffVms: includeOff, skipNameContains: 'keep' }, summary: `older than ${snapAge} days${includeIdle ? '; include idle VMs' : ''}${includeOff ? '; include powered-off VMs' : ''}; skip snapshots whose name contains "keep"`, deletes: true },
        ...(deleteOff ? [{ name: 'Delete powered-off VMs', action: 'DELETE_POWERED_OFF_VMS', interfaceAction: 'Reclaim → Delete powered off VMs', params: { poweredOffDays: 90 }, summary: 'powered off for the Reclaim threshold (90 days suggested)', deletes: true }] : []),
        ...(downsize ? [{ name: 'Downsize oversized VMs', action: 'DOWNSIZE_OVERSIZED_VMS', interfaceAction: 'Rightsize → Downsize oversized VMs', params: { includeIdleVms: includeIdle }, summary: `${includeIdle ? 'include idle VMs; ' : ''}needs a reboot unless hot-remove applies — run in the window`, deletes: false }] : []),
        ...(upsize ? [{ name: 'Scale up undersized VMs', action: 'UPSIZE_UNDERSIZED_VMS', interfaceAction: 'Rightsize → Scale-up undersized VMs', params: {}, summary: 'adds capacity; check the cluster has it', deletes: false }] : []),
      ];
      const when = /^\s*([a-z]+)\s+(\d{1,2}):(\d{2})\s*$/i.exec(window);
      const weekday = when ? when[1]!.toUpperCase() : '';
      const time = when ? `${when[2]!.padStart(2, '0')}:${when[3]}` : '';
      if (!when || WEEKDAYS[when[1]!.toLowerCase()] === undefined) findings.push(error('vcfops.reclaim91.window', `“${window}” is not a weekday and a time, such as Sunday 02:00.`, { source: SRC }));

      const jobsJson = {
        $comment: 'Automation Central jobs. apply-jobs.sh creates each (or updates the one with the same name), enabled, scoped to the group, and reads it back. VERIFY: the job API and these field names are not in the public API reference; the script stops cleanly when the path is not there.',
        group,
        excludeTag,
        minVmAgeDays: minAge,
        jobs: jobs.map((job) => ({
          name: `${job.name} — ${group}`,
          description: `${job.interfaceAction}: ${job.summary}. Scoped to the custom group ${group}.`,
          enabled: true,
          action: job.action,
          parameters: job.params,
          scope: { type: 'CUSTOM_GROUP', groupName: group, groupId: '<set by apply-jobs.sh>' },
          schedule: { recurrence: 'WEEKLY', dayOfWeek: weekday, startTime: time },
        })),
      };

      const applyJobs = [
        '#!/usr/bin/env bash',
        `# Create the Automation Central jobs in automation-central-jobs.json, enabled, scoped to "${group}".`,
        '#',
        '# Each job is created, or updated when one with the same name exists, and read back.',
        '# The VM age exclusion is set in Global Settings. Applies when run; --dry-run prints and',
        '# changes nothing. VERIFY: Automation Central is served under /suite-api/internal on',
        '# the builds this was written against; set JOBS_PATH if yours differs. If the path is',
        '# not there the script stops and prints the interface steps instead.',
        'set -euo pipefail',
        '',
        ...authPreamble(PLATFORM),
        'for tool in curl jq; do command -v "$tool" >/dev/null || { echo "$tool is required" >&2; exit 2; }; done',
        'EXECUTE=1',
        '[[ "${1:-}" == "--dry-run" ]] && EXECUTE=0',
        'HERE=$(cd "$(dirname "$0")" && pwd)',
        'JOBS="$HERE/automation-central-jobs.json"',
        'WORK=$(umask 077; mktemp -d)',
        `trap 'rm -rf "$WORK"${AUTH_FILE_VAR ? `; rm -f "$${AUTH_FILE_VAR}"` : ''}' EXIT`,
        ...API_FN,
        ...GLOBAL_SETTING_FN,
        'JOBS_PATH="${JOBS_PATH:-/suite-api/internal/automationcentral/jobs}"',
        '',
        '# The group, by name: exactly one.',
        'GROUP=$(jq -r .group "$JOBS")',
        'GROUP_ID=$(api GET "/suite-api/api/resources/groups?pageSize=10000" | jq -r --arg n "$GROUP" \'[.groups[]? | select(.resourceKey.name == $n) | .id] | if length == 1 then .[0] else "" end\')',
        '[[ -n "$GROUP_ID" ]] || { echo "Expected exactly one custom group named \\"${GROUP}\\". Create it first (\\"A custom group to scope automation\\")." >&2; exit 2; }',
        'echo "Group ${GROUP}: ${GROUP_ID}"',
        '',
        '# VM age exclusion (Global Settings). Not fatal if the key cannot be found: it says so.',
        `set_global '(exclu.*age|vm.?age|min.*age)' "$(jq -r .minVmAgeDays "$JOBS")" "VM age exclusion (days)" || echo "Set the VM age exclusion by hand: Operate → Administration → Global Settings." >&2`,
        '',
        'code=$(probe "$JOBS_PATH")',
        'if [[ "$code" != 200 ]]; then',
        '  echo "GET ${JOBS_PATH} returned HTTP ${code}: no Automation Central API at that path on this build." >&2',
        '  echo "Create each job by hand, enabled, under Manage → Automation Central, scoped to the group ${GROUP}:" >&2',
        '  jq -r \'.jobs[] | "  \\(.name): \\(.description) Weekly, \\(.schedule.dayOfWeek) \\(.schedule.startTime)."\' "$JOBS" >&2',
        '  exit 3',
        'fi',
        'api GET "$JOBS_PATH" >"$WORK/existing.json"',
        'n=$(jq \'.jobs | length\' "$JOBS")',
        'for (( i = 0; i < n; i++ )); do',
        '  jq --arg g "$GROUP_ID" ".jobs[$i] | .scope.groupId = \\$g" "$JOBS" >"$WORK/job.json"',
        '  name=$(jq -r .name "$WORK/job.json")',
        '  id=$(jq -r --arg n "$name" \'[.. | objects | select(.name? == $n) | (.id // .jobId // empty)] | unique | if length == 1 then .[0] else "" end\' "$WORK/existing.json")',
        '  if (( ! EXECUTE )); then echo "DRY RUN: would $([[ -n "$id" ]] && echo "update ${id}" || echo create) \\"${name}\\", enabled."; continue; fi',
        '  if [[ -n "$id" ]]; then',
        '    jq --arg id "$id" \'.id = $id\' "$WORK/job.json" | api PUT "${JOBS_PATH}/${id}" -H "Content-Type: application/json" --data-binary @- >/dev/null',
        '  else',
        '    id=$(api POST "$JOBS_PATH" -H "Content-Type: application/json" --data-binary @"$WORK/job.json" | jq -r \'.id // .jobId // empty\')',
        '    [[ -n "$id" ]] || { echo "Created \\"${name}\\" but no id came back; check Automation Central before running again." >&2; exit 1; }',
        '  fi',
        '  api GET "${JOBS_PATH}/${id}" >"$WORK/back.json"',
        '  if ! jq -e --arg n "$name" \'.name == $n and (.enabled // .isEnabled) == true\' "$WORK/back.json" >/dev/null; then',
        '    echo "\\"${name}\\" (${id}) does not read back enabled with that name. Check it in Automation Central." >&2',
        '    exit 1',
        '  fi',
        '  echo "\\"${name}\\" (${id}): enabled, scoped to ${GROUP}."',
        'done',
        'if (( ! EXECUTE )); then echo "Dry run: nothing was changed. Run it without --dry-run to apply."; exit 0; fi',
        'echo "Now open each job’s preview of affected VMs, and check a VM tagged $(jq -r .excludeTag "$JOBS") is not in it."',
        '',
      ].join('\n');

      const preflight = readScript('vcf-operations', `Pre-run check for the reclamation jobs on "${group}": export, then fail if the scope is over the cap.`, [
        ...POST_QUERY,
        ...LARGE_DATA,
        `GROUP_NAME=${JSON.stringify(group)}`,
        `MAX_OBJECTS=${cap}`,
        '',
        '# The group by name, unless GROUP_ID is given: exactly one.',
        'if [[ -z "${GROUP_ID:-}" ]]; then',
        '  GROUP_ID=$(get "/suite-api/api/resources/groups?pageSize=10000" | jq -r --arg n "$GROUP_NAME" \'[.groups[]? | select(.resourceKey.name == $n) | .id] | if length == 1 then .[0] else "" end\')',
        '  [[ -n "$GROUP_ID" ]] || { echo "Expected exactly one custom group named ${GROUP_NAME}; set GROUP_ID." >&2; exit 2; }',
        'fi',
        '',
        '# Every member, every page: a group of thousands is exactly when this check matters.',
        'get_all "/suite-api/api/resources/groups/${GROUP_ID}/members" "$WORK/all.json"',
        'jq -c \'[.[] | select(.resourceKey.resourceKindKey == "VirtualMachine") | {id: .identifier, name: .resourceKey.name}]\' "$WORK/all.json" >"$WORK/members.json"',
        'count=$(jq length "$WORK/members.json")',
        '',
        '# Signals exported beside each VM. VERIFY these keys with',
        '# GET /suite-api/api/resources/{id}/statkeys on one VM; a missing key exports blank.',
        'echo \'["sys|poweredOn","summary|oversized","summary|undersized","summary|idle","diskspace|snapshot|age"]\' >"$WORK/keys.json"',
        'out="reclaim-scope-$(date +%Y%m%d).csv"',
        'if (( count > 0 )); then',
        '  jq -c \'[.[].id]\' "$WORK/members.json" >"$WORK/ids.json"',
        '  latest_map "$WORK/ids.json" "$WORK/keys.json" "$WORK/latest.json"',
        '  jq -r -n --slurpfile v "$WORK/latest.json" --slurpfile m "$WORK/members.json" --slurpfile k "$WORK/keys.json" \'($v[0]) as $v | ($k[0]) as $k',
        '    | (["name","id"] + $k | @csv), ($m[0][] | . as $vm | ([$vm.name, $vm.id] + [$k[] as $key | ($v[$vm.id][$key] // "")]) | @csv)\' >"$out"',
        'else',
        '  echo "name,id" >"$out"',
        'fi',
        'echo "${count} VM(s) in scope; exported to ${out}."',
        '',
        'if (( count > MAX_OBJECTS )); then',
        '  echo "The group has ${count} VMs, over the cap of ${MAX_OBJECTS}. Pause the Automation Central jobs and narrow the group before they run." >&2',
        '  exit 1',
        'fi',
        'if (( count == 0 )); then echo "The group is empty; the jobs will do nothing." >&2; exit 1; fi',
        'echo "Within the cap."',
      ]);

      const crontab = [
        '# Pre-run check, the day before the jobs. It exits 1 over the cap; route cron mail or',
        '# the exit code to whoever can pause the jobs. No secret here: the script logs in from its password file.',
        `${dayBefore(window)} ${scheduledEnv(PLATFORM)} /opt/vcf-automation/${base}-preflight.sh >>/var/log/vcf-automation/${base}-preflight.log 2>&1`,
        `# The jobs themselves run in Automation Central at ${window} (cron equivalent: ${cronOf(window)}) — not from cron.`,
        '',
      ].join('\n');

      return {
        platform: PLATFORM,
        title: `Reclamation jobs on “${group || 'no group'}” — snapshots over ${snapAge} days${downsize ? ', downsizing' : ''}${deleteOff ? ', powered-off VM deletion' : ''}`,
        effect: 'irreversible',
        trigger: { kind: 'schedule', detail: `${window}, from Automation Central; the pre-run check a day earlier from cron`, worstCase: 'every member of the group, once a week — Automation Central has no per-run cap' },
        scope: {
          what: `VMs in the custom group "${group || '(none)'}" that qualify for each job, minus everything the exclusion settings remove.`,
          decidedBy: [
            `The custom group "${group || '(none)'}", resolved when the job runs.`,
            `The Reclaim and Rightsize exclusion tag ${excludeTag || '(none)'}, which Broadcom’s 9.1 guidance says Automation Central honours (VERIFY in the job preview).`,
            `The age exclusion (${minAge} days) and the automatic exclusion of Broadcom appliances — documented for recommendations; not documented for Automation Central jobs (VERIFY).`,
            'Each job’s own criteria (snapshot age, idle or powered-off status, oversized or undersized).',
          ],
          ifWrong: 'Snapshots that were someone’s rollback are deleted and VMs are resized or deleted across the whole group in one run. Snapshot and VM deletion cannot be undone.',
        },
        guardrails: [
          { rule: `VMs tagged ${excludeTag || '(none)'} are excluded — by the platform, once set in the Reclaim and Rightsize exclusion settings`, because: 'Broadcom’s 9.1 guidance is that a VM excluded on the Reclaim or Rightsize page is excluded from Automation Central too, so one tag takes a VM out of every reclamation path at once. The techdocs do not say so yet: check a tagged VM is missing from each job’s preview.' },
          { rule: 'Every job is scoped to the named custom group, resolved to exactly one id, and read back enabled', because: 'A job scoped to a datacenter is a job scoped to everything in it.' },
          { rule: `Pre-run check exits 1 when the group has more than ${cap} VMs`, because: 'Automation Central has no cap of its own. The check cannot stop the job, but it fails loudly the day before, when someone can still pause it.' },
          { rule: 'The scope is exported to CSV before every run', because: 'After a deletion the question is always “what was in scope”; the export is the answer, dated.' },
          { rule: `VMs younger than ${minAge} days excluded from recommendations (Global Settings, set by apply-jobs.sh)`, because: 'A week of history makes every new VM look oversized. Documented for recommendations only — whether Automation Central honours it is the preview’s to show.' },
        ],
        dryRun: ['apply-jobs.sh --dry-run prints each job it would create or update and changes nothing.', 'Run the preflight script by hand and read the CSV. Every VM in it is one the jobs may act on. Open each job’s preview before its first run.'],
        undo: [
          'Deleted snapshots and deleted VMs cannot be restored except from backup.',
          'A downsize or scale-up is reversed by resizing back — the job history in Automation Central records the before and after.',
          'Disable or delete the job in Automation Central (or DELETE it at the job path) to stop the next run.',
        ],
        told: ['Automation Central keeps a history of each run and the objects it acted on.', 'The pre-run CSV and its exit code, from cron mail.', 'The reclamation dashboard, monthly.'],
        requires: [
          `The custom group "${group}" (opt-in tag, exclusion tag).`,
          `vSphere tag ${excludeTag} created in vCenter and collected by VCF Operations, and selected in the Reclaim and Rightsize exclusion settings (no documented API: Manage → Capacity → Optimize → Reclaim → settings, and Rightsize → Exclusion Settings).`,
          'Actions enabled on the vCenter adapter, with an account that has the rights these jobs need and no more.',
        ],
        files: {
          'automation-central-jobs.json': `${JSON.stringify(jobsJson, null, 2)}\n`,
          'apply-jobs.sh': applyJobs,
          [`${base}-preflight.sh`]: preflight,
          'crontab.txt': crontab,
          'IMPORT.md': importMd({
            title: `reclamation jobs on "${group}"`,
            intro: ['Nothing here is a file VCF Operations imports: apply-jobs.sh writes the jobs through the API, and the preflight runs from cron.'],
            steps: [
              { heading: 'Exclusions first', files: [], how: [`Manage → Capacity → Optimize → Reclaim → settings, and Rightsize → Exclusion Settings: select the tag ${excludeTag || '(none)'}. There is no documented API for these settings. apply-jobs.sh sets the VM age exclusion (${minAge} days) in Global Settings.`] },
              { heading: 'The jobs', files: ['automation-central-jobs.json', 'apply-jobs.sh'], how: ['./apply-jobs.sh — resolves the group, creates or updates each job enabled, reads it back. --dry-run prints and changes nothing.'], verify: ['the Automation Central job path (JOBS_PATH) and the field names in automation-central-jobs.json. Without the path the script prints the exact interface steps instead.'] },
              { heading: 'The pre-run check', files: [`${base}-preflight.sh`, 'crontab.txt'], how: ['Install the script under /opt/vcf-automation and the crontab line. It runs the day before the jobs and exits 1 over the cap.'] },
              { heading: 'Order and review', files: [], how: ['A VM can appear under snapshot reclamation, idle and rightsizing at once (9.1); the jobs run snapshots first, then rightsizing, so a VM is not resized the week before it is deleted. Review the Reclamation dashboard monthly.'] },
            ],
          }),
        },
        notes: [
          'For snapshot or powered-off deletion with a hard per-run cap enforced by a script instead of Automation Central, use “Reclaim idle and oversized VMs on a schedule”.',
          'VERIFY: the Automation Central job API is not in the public API reference; apply-jobs.sh uses /suite-api/internal/automationcentral/jobs by default and stops with the interface steps when it is not there. The Reclaim and Rightsize tag exclusion has no documented API.',
          'Exclusions, as documented: tag, age and history exclusions and the automatic exclusion of Broadcom appliances apply to rightsizing and reclamation recommendations (9.1 release notes; techdocs “Using Reclaim to Free Up Resources”). That tag exclusions carry to Automation Central comes from Broadcom’s Brock Peterson (brockpeterson.com, 9.1 exclusions post), not the techdocs; nothing documents appliance or age exclusions for Automation Central. VERIFY each in a job preview.',
          'The stat keys the pre-run export reads are the VMware adapter’s as documented for earlier releases; a key that is not present exports blank rather than failing.',
          'Orphaned disks are not an Automation Central job: generate this blueprint again with “Orphaned disks — move to quarantine”.',
        ],
        findings,
      };
    },
  }),

  // -------------------------------------------------------------------------
  automationBlueprint({
    id: 'vcfops_capacity_policy',
    platform: PLATFORM,
    label: 'Capacity settings in a policy, with a monthly capacity report',
    group: 'Capacity',
    description:
      'The capacity half of a policy, decided rather than inherited: allocation or demand, overcommit, buffers per resource, time-remaining thresholds, forecast risk level, and the 9.1 additions — storage-based workload eviction, network port group placement, and exclusions by tag and VM age. Applied: merged into an export of the policy, imported, and read back (the policy is put back if a value does not stick), with the VM age exclusion set in Global Settings and the monthly capacity report scheduled so someone reads the result.',
    inputs: [
      { id: 'policy_name', label: 'Policy', control: 'text', default: 'Capacity — production clusters' },
      { id: 'groups', label: 'Applies to groups', control: 'text', default: 'Production clusters' },
      { id: 'model', label: 'Capacity model', control: 'select', options: [{ value: 'allocation', label: 'Allocation — what is promised' }, { value: 'demand', label: 'Demand — what is used' }], default: 'allocation' },
      { id: 'cpu_overcommit', label: 'CPU overcommit (vCPU:core)', control: 'number', default: 4, min: 1, max: 20, showWhen: { input: 'model', equals: ['allocation'] } },
      { id: 'mem_overcommit', label: 'Memory overcommit', control: 'number', default: 1, min: 1, max: 4, showWhen: { input: 'model', equals: ['allocation'] } },
      { id: 'buffer_cpu', label: 'CPU buffer %', control: 'number', default: 10, min: 0, max: 50 },
      { id: 'buffer_mem', label: 'Memory buffer %', control: 'number', default: 10, min: 0, max: 50 },
      { id: 'buffer_disk', label: 'Disk buffer %', control: 'number', default: 15, min: 0, max: 50 },
      { id: 'risk', label: 'Forecast risk level', control: 'select', options: [{ value: 'conservative', label: 'Conservative — plan for the upper forecast' }, { value: 'aggressive', label: 'Aggressive — plan for the mean' }], default: 'conservative' },
      { id: 'tr_warning', label: 'Warn when time remaining under (days)', control: 'number', default: 120, min: 1, max: 730 },
      { id: 'tr_critical', label: 'Critical when time remaining under (days)', control: 'number', default: 60, min: 1, max: 730 },
      { id: 'storage_eviction', label: 'Storage-based workload eviction', control: 'toggle', default: true, hint: '9.1: Workload Automation moves VMs off a cluster whose storage is stressed' },
      { id: 'storage_threshold', label: 'Evict when datastore use above (%)', control: 'number', default: 85, min: 50, max: 99, showWhen: { input: 'storage_eviction', equals: ['true'] } },
      { id: 'port_groups', label: 'Place across equivalent port groups', control: 'toggle', default: false, hint: '9.1, for All Apps organizations' },
      { id: 'exclude_tag', label: 'Exclude from recommendations (tag)', control: 'text', default: 'Automation=never' },
      { id: 'min_vm_age', label: 'Exclude VMs younger than (days)', control: 'number', default: 30, min: 0, max: 365 },
      { id: 'report_name', label: 'Report definition', control: 'text', default: 'Cluster capacity' },
      { id: 'recipients', label: 'Send the report to', control: 'text', default: 'capacity-team@example.com' },
      { id: 'day_of_month', label: 'On day of month', control: 'number', default: 1, min: 1, max: 28 },
      { id: 'scope_object', label: 'Run it for', control: 'text', default: 'vSphere World' },
    ],
    automation: (values: BlueprintValues, name: string): Automation => {
      const policy = str(values, 'policy_name', 'Capacity');
      const groups = listOf(str(values, 'groups', ''));
      const model = str(values, 'model', 'allocation');
      const cpuOc = num(values, 'cpu_overcommit', 4);
      const memOc = num(values, 'mem_overcommit', 1);
      const bCpu = num(values, 'buffer_cpu', 10);
      const bMem = num(values, 'buffer_mem', 10);
      const bDisk = num(values, 'buffer_disk', 15);
      const risk = str(values, 'risk', 'conservative');
      const trWarn = num(values, 'tr_warning', 120);
      const trCrit = num(values, 'tr_critical', 60);
      const eviction = bool(values, 'storage_eviction', true);
      const storageThreshold = num(values, 'storage_threshold', 85);
      const portGroups = bool(values, 'port_groups', false);
      const excludeTag = str(values, 'exclude_tag', '');
      const minAge = num(values, 'min_vm_age', 30);
      const reportName = str(values, 'report_name', 'Cluster capacity');
      const recipients = listOf(str(values, 'recipients', ''));
      const dom = num(values, 'day_of_month', 1);
      const scopeObject = str(values, 'scope_object', 'vSphere World');
      const base = slugOf(name || policy, 'capacity-policy');

      const findings: Finding[] = [];
      if (groups.length === 0) findings.push(error('vcfops.capacity.unassigned', 'A policy assigned to no group applies to nothing.', { source: SRC }));
      if (trCrit >= trWarn) findings.push(error('vcfops.capacity.thresholds', `The critical threshold (${trCrit} days) is not below the warning threshold (${trWarn} days).`, { source: SRC }));
      if (recipients.length === 0) findings.push(error('vcfops.capacity.no-recipient', 'The capacity report goes to nobody.', { source: SRC }));
      if (trWarn < 90) findings.push(warning('vcfops.capacity.short-warning', `${trWarn} days is less than most hardware lead times.`, { remediation: 'The warning exists to start a purchase. Set it to procurement plus racking time — usually 90 to 180 days.', source: SRC }));
      if (bCpu === 0 && bMem === 0) findings.push(warning('vcfops.capacity.no-buffer', 'No CPU or memory buffer: capacity is reported as available right up to the host failure that takes it away.', { remediation: 'Cover at least one host per cluster, unless HA admission control already reserves it — then say so in the design.', source: SRC }));
      if (model === 'allocation' && memOc > 1.5) findings.push(warning('vcfops.capacity.mem-overcommit', `${memOc}:1 memory overcommit plans for ballooning and swap.`, { source: SRC }));
      if (risk === 'aggressive') findings.push(info('vcfops.capacity.aggressive', 'Aggressive planning uses the mean forecast, so time remaining runs out about half the time before it says it will.', { source: SRC }));
      if (eviction && storageThreshold > 90) findings.push(warning('vcfops.capacity.eviction-late', `Evicting at ${storageThreshold}% leaves little room to move anything — Storage vMotion needs free space on the source and destination while it runs.`, { source: SRC }));
      if (!excludeTag.trim()) findings.push(warning('vcfops.capacity.no-exclusion', 'No exclusion tag, so every VM is a rightsizing and eviction candidate.', { source: SRC }));

      const rows: [string, string, string][] = [
        ['Capacity model', model, model === 'allocation' ? 'Plans against what has been promised — what a production service can call on.' : 'Plans against use; reclaims more and protects less.'],
        ...(model === 'allocation' ? ([['CPU overcommit', `${cpuOc}:1`, cpuOc > 6 ? 'High; watch CPU ready.' : 'A common production ratio.'], ['Memory overcommit', `${memOc}:1`, memOc > 1 ? 'Relies on memory reclamation under load.' : 'No reliance on ballooning or swap.']] as [string, string, string][]) : []),
        ['Buffer — CPU / memory / disk', `${bCpu}% / ${bMem}% / ${bDisk}%`, 'Held back from what is reported available. Disk higher: it fills without warning and cannot be overcommitted back.'],
        ['Forecast risk level', risk, risk === 'conservative' ? 'Plans against the upper range of the forecast.' : 'Plans against the mean.'],
        ['Time remaining — warning / critical', `${trWarn} / ${trCrit} days`, 'Warning starts a purchase; critical escalates it.'],
        ['Storage-based workload eviction (9.1)', eviction ? `on, above ${storageThreshold}% datastore use` : 'off', eviction ? 'Workload Automation moves VMs off a cluster whose storage is stressed, not only CPU and memory.' : 'Only CPU and memory drive workload moves.'],
        ['Network port group placement (9.1)', portGroups ? 'on' : 'off', portGroups ? 'VMs in All Apps organizations can be placed across equivalent port groups, so a move is not blocked by a port group name.' : 'Moves stay within the same port group.'],
        ['Exclusions (9.1)', `${excludeTag || 'no tag'}; VMs younger than ${minAge} days; Broadcom appliances`, 'Excluded VMs are not recommended for rightsizing, reclamation or moves.'],
      ];

      const design = [
        `# ${policy} — capacity settings`,
        '',
        'Only the capacity settings; everything else the policy has is kept. merge-policy.sh applies them.',
        '',
        '| Setting | Value | Why |',
        '|---|---|---|',
        ...rows.map(([s, v, w]) => `| ${s} | ${v} | ${w} |`),
        '',
        `Applies to: ${groups.join(', ') || '(nothing)'}.`,
        '',
      ].join('\n');

      const overridesFile = `${base}-capacity-overrides.xml`;
      const overrides = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<!-- The capacity and Workload Automation values merge-policy.sh sets in the policy. Only these',
        '     elements and attributes change; the rest of the policy is kept. VERIFY the element and',
        '     attribute names against an export of a policy where one capacity value was set by hand:',
        '     merge-policy.sh stops before importing an element the export has nowhere, and after the',
        '     import checks every value stuck, putting the policy back if one did not. -->',
        '<PolicyOverrides>',
        '    <PackageSettings>',
        `        <CapacitySettings adapterKind="VMWARE" resourceKind="ClusterComputeResource" model="${model === 'allocation' ? 'ALLOCATION' : 'DEMAND'}" riskLevel="${risk === 'conservative' ? 'CONSERVATIVE' : 'AGGRESSIVE'}">`,
        ...(model === 'allocation' ? [`            <Allocation enabled="true" cpuOvercommitRatio="${cpuOc}" memoryOvercommitRatio="${memOc}"/>`] : []),
        `            <Buffer cpu="${bCpu}" memory="${bMem}" diskSpace="${bDisk}"/>`,
        `            <TimeRemaining warningDays="${trWarn}" criticalDays="${trCrit}"/>`,
        '        </CapacitySettings>',
        `        <WorkloadAutomation adapterKind="VMWARE" resourceKind="ClusterComputeResource" storageBasedEviction="${eviction}"${eviction ? ` storageThresholdPercent="${storageThreshold}"` : ''} networkPortGroupPlacement="${portGroups}"/>`,
        '    </PackageSettings>',
        '</PolicyOverrides>',
        '',
      ].join('\n');

      const schedule = {
        reportDefinitionId: '<set by apply-report-schedule.sh>',
        resourceId: ['<set by apply-report-schedule.sh>'],
        reportScheduleType: 'MONTHLY',
        recurrence: 1,
        dayOfTheMonth: dom,
        startDate: '<set by apply-report-schedule.sh: START_DATE, or today>',
        startHour: 7,
        startMinute: 0,
        emailAddresses: recipients,
        relativePath: [],
      };

      const apply = [
        '#!/usr/bin/env bash',
        `# Schedule the report "${reportName}" for "${scopeObject}" monthly, on day ${dom}, at 07:00 GMT.`,
        '#',
        '# The report definition and the object are found by name (or set REPORT_DEFINITION_ID and',
        '# RESOURCE_ID). A schedule already there for the same day is left alone, so it is safe to run',
        '# again. Schedules created through the API run in GMT. Applies when run; --dry-run prints.',
        'set -euo pipefail',
        '',
        ...authPreamble(PLATFORM),
        'command -v jq >/dev/null || { echo "jq is required" >&2; exit 2; }',
        'EXECUTE=1',
        '[[ "${1:-}" == "--dry-run" ]] && EXECUTE=0',
        'HERE=$(cd "$(dirname "$0")" && pwd)',
        'WORK=$(umask 077; mktemp -d)',
        `trap 'rm -rf "$WORK"${AUTH_FILE_VAR ? `; rm -f "$${AUTH_FILE_VAR}"` : ''}' EXIT`,
        ...API_FN,
        `REPORT_NAME=${JSON.stringify(reportName)}`,
        `SCOPE_NAME=${JSON.stringify(scopeObject)}`,
        'if [[ -z "${REPORT_DEFINITION_ID:-}" ]]; then',
        '  REPORT_DEFINITION_ID=$(api GET "/suite-api/api/reportdefinitions?name=$(jq -rn --arg n "$REPORT_NAME" \'$n|@uri\')" | jq -r --arg n "$REPORT_NAME" \'[.reportDefinitions[]? | select(.name == $n) | .id] | if length == 1 then .[0] else "" end\')',
        '  [[ -n "$REPORT_DEFINITION_ID" ]] || { echo "Expected exactly one report definition named \\"${REPORT_NAME}\\"; set REPORT_DEFINITION_ID." >&2; exit 2; }',
        'fi',
        'if [[ -z "${RESOURCE_ID:-}" ]]; then',
        '  RESOURCE_ID=$(api GET "/suite-api/api/resources?name=$(jq -rn --arg n "$SCOPE_NAME" \'$n|@uri\')" | jq -r --arg n "$SCOPE_NAME" \'[.resourceList[]? | select(.resourceKey.name == $n) | .identifier] | if length == 1 then .[0] else "" end\')',
        '  [[ -n "$RESOURCE_ID" ]] || { echo "Expected exactly one object named \\"${SCOPE_NAME}\\"; set RESOURCE_ID." >&2; exit 2; }',
        'fi',
        '# VERIFY the date format against GET of an existing schedule on your build.',
        'START_DATE="${START_DATE:-$(date -u +%m/%d/%Y)}"',
        '',
        'body=$(jq --arg d "$REPORT_DEFINITION_ID" --arg r "$RESOURCE_ID" --arg s "$START_DATE" \'.reportDefinitionId = $d | .resourceId = [$r] | .startDate = $s\' "$HERE/capacity-report-schedule.json")',
        'path="/suite-api/api/reportdefinitions/${REPORT_DEFINITION_ID}/schedules"',
        `if api GET "$path" | jq -e --argjson day ${dom} '[.reportSchedules[]? | select(.reportScheduleType == "MONTHLY" and .dayOfTheMonth == $day)] | length > 0' >/dev/null; then`,
        `  echo "A monthly schedule on day ${dom} already exists for this report. Nothing to do."`,
        '  exit 0',
        'fi',
        'if (( ! EXECUTE )); then',
        '  echo "DRY RUN: would POST to https://${VCFOPS_HOST}${path}:"',
        '  echo "$body"',
        '  echo "Dry run: nothing was changed. Run it without --dry-run to apply."',
        '  exit 0',
        'fi',
        'printf \'%s\' "$body" | api POST "$path" -H "Content-Type: application/json" --data-binary @- >/dev/null',
        `api GET "$path" | jq -e --argjson day ${dom} '[.reportSchedules[]? | select(.dayOfTheMonth == $day)] | length > 0' >/dev/null || { echo "Posted, but the schedule does not read back." >&2; exit 1; }`,
        'echo "Scheduled and read back."',
        '',
        '# Undo: GET ${path} for the schedule id, then',
        '#   DELETE /suite-api/api/reportdefinitions/${REPORT_DEFINITION_ID}/schedules/{scheduleId}',
        '',
      ].join('\n');

      const exclusions = [
        '#!/usr/bin/env bash',
        `# Exclude VMs younger than ${minAge} days from rightsizing, reclamation and move recommendations`,
        '# (Global Settings). The tag exclusion has no documented API: it is printed as the one step left.',
        '# Applies when run; --dry-run prints and changes nothing.',
        'set -euo pipefail',
        '',
        ...authPreamble(PLATFORM),
        'command -v jq >/dev/null || { echo "jq is required" >&2; exit 2; }',
        'EXECUTE=1',
        '[[ "${1:-}" == "--dry-run" ]] && EXECUTE=0',
        'WORK=$(umask 077; mktemp -d)',
        `trap 'rm -rf "$WORK"${AUTH_FILE_VAR ? `; rm -f "$${AUTH_FILE_VAR}"` : ''}' EXIT`,
        ...API_FN,
        ...GLOBAL_SETTING_FN,
        `set_global '(exclu.*age|vm.?age|min.*age)' ${minAge} "VM age exclusion (days)"`,
        ...(excludeTag.trim() ? [`echo "One interface step left (no documented API): Manage → Capacity → Optimize → Rightsize → Exclusion Settings, and Reclaim → settings: select the tag ${excludeTag}."`] : []),
        '',
      ].join('\n');

      return {
        platform: PLATFORM,
        title: `${policy} — ${model} capacity, ${trWarn}/${trCrit}-day thresholds${eviction ? ', storage eviction' : ''}, monthly report`,
        effect: 'reversible',
        trigger: { kind: 'schedule', detail: `Capacity is recalculated every collection cycle; the report goes out monthly on day ${dom} at 07:00 GMT.`, worstCase: eviction ? 'Workload Automation moves on every run it is scheduled for, when storage crosses the threshold' : 'once a month, a report' },
        scope: {
          what: `Clusters, hosts, datastores and VMs in ${groups.join(', ') || '(no groups)'}, unless a higher-priority policy covers them.`,
          decidedBy: ['The groups the policy is assigned to, and its priority against other policies on the same objects.', `Exclusions: tag ${excludeTag || '(none)'}, VM age ${minAge} days, Broadcom appliances.`, eviction ? 'Workload Automation’s own schedule and automation level, which decide whether an eviction is recommended or performed.' : 'No eviction.'],
          ifWrong: 'Time remaining is wrong for the clusters people buy hardware for — too early and money is spent, too late and a cluster fills. With eviction on, VMs are storage-vMotioned on a threshold meant for somewhere else.',
        },
        guardrails: [
          { rule: 'merge-policy.sh exports the policy first and changes only the capacity elements', because: 'The export is the undo, and a policy import that carried only these lines would drop every other override the policy has.' },
          { rule: 'It stops before importing an element the export does not have, and after the import reads every value back — importing the first export again if one did not stick', because: 'A policy import silently drops an element the release does not know. The read-back turns that into an exit 1 with the policy as it was.' },
          { rule: 'The report schedule is found by name, never duplicated, and read back', because: 'A second schedule sends every report twice; a missing one sends nothing, and nobody notices a report that never arrives.' },
          { rule: `Excluded: ${excludeTag || 'no tag'}, VMs under ${minAge} days, Broadcom appliances`, because: 'The platform leaves excluded VMs out of rightsizing and reclamation recommendations. Whether that also covers the eviction moves this policy turns on is not documented — VERIFY before turning eviction to act.' },
        ],
        dryRun: ['Run merge-policy.sh --dry-run: it exports, merges, prints every value it would change and writes import/policy-merged.zip without importing it.', 'Run apply-report-schedule.sh --dry-run and apply-exclusions.sh --dry-run and read what they would send.', ...(eviction ? ['Set Workload Automation to recommend, not act, for the first month and read what it would have moved.'] : [])],
        undo: ['Import the policy-before-<time>.zip merge-policy.sh saved (POST /suite-api/api/policies/import?forceImport=true), or unassign the groups.', 'Delete the report schedule: DELETE /suite-api/api/reportdefinitions/{id}/schedules/{scheduleId}.', ...(eviction ? ['VMs already moved by eviction stay where they are; move them back with vMotion if needed.'] : [])],
        told: [`${recipients.join(', ') || 'Nobody'}, monthly, with the capacity report.`, 'Capacity time-remaining alerts, through whatever notification rules match them.'],
        requires: [`The policy "${policy}", assigned to ${groups.join(', ') || '(none)'} (the script finds it by name, or set POLICY_ID).`, `The report definition "${reportName}" and the object "${scopeObject}".`, 'An outbound mail plugin in VCF Operations.', 'curl, jq and python3 on the machine that runs the scripts.', ...(eviction ? ['Workload Automation enabled for these clusters, and Storage vMotion allowed between their datastores.'] : [])],
        files: {
          [`${base}-design.md`]: design,
          [overridesFile]: overrides,
          'merge-policy.sh': policySectionMergeScript(overridesFile, policy, 'capacity and Workload Automation settings'),
          'apply-exclusions.sh': exclusions,
          'capacity-report-schedule.json': `${JSON.stringify(schedule, null, 2)}\n`,
          'apply-report-schedule.sh': apply,
          'IMPORT.md': importMd({
            title: `capacity settings in "${policy}"`,
            intro: ['Each step says which file goes where, in the order they depend on each other. Menu paths are VCF Operations 9.1.'],
            steps: [
              {
                heading: 'The capacity settings, merged into the policy',
                files: [overridesFile, 'merge-policy.sh'],
                how: [
                  `${overridesFile} is the change, not a policy to import on its own: a policy file holds all of a policy's overrides.`,
                  './merge-policy.sh exports the policy (the undo), merges these values in, imports the result (POST /suite-api/api/policies/import?forceImport=true) and reads every value back. --dry-run stops before the import and leaves import/policy-merged.zip to look at.',
                ],
                verify: ['the element and attribute names in the overrides file. The script refuses an element the export has nowhere unless ALLOW_NEW=1, and restores the policy if a value does not read back.'],
              },
              { heading: 'Exclusions', files: ['apply-exclusions.sh'], how: ['./apply-exclusions.sh sets the VM age exclusion in Global Settings and prints the one interface step for the tag exclusion (no documented API).'] },
              { heading: 'Schedule the report', files: ['capacity-report-schedule.json', 'apply-report-schedule.sh'], how: ['./apply-report-schedule.sh — POST /suite-api/api/reportdefinitions/{id}/schedules, found by name, not duplicated, read back.'] },
            ],
          }),
        },
        notes: [
          'The report schedule uses POST /suite-api/api/reportdefinitions/{id}/schedules, the same as “Email a capacity report on a schedule”. Formats are set on the report definition, not the schedule.',
          '9.1 also improved storage visibility across vSAN, VMFS, NFS and vVol for clusters, hosts and VMs, and reworked the forecasting for explainability — expect time-remaining figures to move after an upgrade to 9.1 without any policy change.',
          'VERIFY: the capacity and Workload Automation element names in the policy XML are not published. merge-policy.sh is built to find out safely — it refuses unknown elements before importing and restores the policy if a value is dropped.',
        ],
        findings,
      };
    },
  }),

  // -------------------------------------------------------------------------
  automationBlueprint({
    id: 'vcfops_vks_cost',
    platform: PLATFORM,
    label: 'VKS cost per vSphere Namespace, for showback',
    group: 'Cost',
    description:
      'VCF Operations 9.1 costs VKS down to nodes, clusters, vSphere Namespaces, projects and organizations. This reads that cost per namespace — discovering the namespace object type and its cost metrics rather than assuming their names — rolls it up by an organization property if you give one, writes a monthly CSV for showback, and fails when a namespace has no cost at all, which is the sign the cost engine is not covering it.',
    inputs: [
      { id: 'ns_kind', label: 'Namespace object type', control: 'text', default: 'Namespace', hint: 'The resource kind VCF Operations uses for vSphere Namespaces. The script lists candidates if this finds nothing' },
      { id: 'ns_adapter', label: 'Adapter', control: 'text', default: 'VMWARE' },
      { id: 'group_by', label: 'Roll up by', control: 'select', options: [{ value: 'namespace', label: 'Namespace only' }, { value: 'property', label: 'A property of the namespace (organization, project)' }], default: 'namespace' },
      { id: 'property_key', label: 'Property key', control: 'text', default: 'summary|organization', showWhen: { input: 'group_by', equals: ['property'] }, hint: 'VERIFY: GET /suite-api/api/resources/{id}/properties on one namespace' },
      { id: 'fail_on_uncosted', label: 'Fail when a namespace has no cost', control: 'toggle', default: true },
      { id: 'schedule', label: 'Run monthly (crontab)', control: 'toggle', default: true, hint: 'Written enabled: first of the month, 06:00' },
    ],
    automation: (values: BlueprintValues, name: string): Automation => {
      const kind = str(values, 'ns_kind', 'Namespace');
      const adapter = str(values, 'ns_adapter', 'VMWARE');
      const groupBy = str(values, 'group_by', 'namespace');
      const propKey = str(values, 'property_key', '');
      const failUncosted = bool(values, 'fail_on_uncosted', true);
      const schedule = bool(values, 'schedule', true);
      const base = slugOf(name || 'vks-cost', 'vks-cost');

      const findings: Finding[] = [];
      if (!kind.trim()) findings.push(error('vcfops.vks.no-kind', 'No namespace object type.', { source: SRC }));
      if (groupBy === 'property' && !propKey.trim()) findings.push(error('vcfops.vks.no-property', 'Roll-up by property needs the property key.', { source: SRC }));
      findings.push(
        info('vcfops.vks.double-count', 'VKS node VMs are VMs. A VM showback that includes them and a namespace showback that includes them bills the same capacity twice.', {
          remediation: 'Use the 9.1 service-type filter on the Organization and Project Showback dashboards (Regular VMs vs VKS) and bill VKS from one place only.',
          source: SRC,
        }),
      );

      const script = readScript('vcf-operations', 'Cost per vSphere Namespace from VCF Operations, as CSV.', [
        ...POST_QUERY,
        ...LARGE_DATA,
        `NS_KIND="\${NS_KIND:-${kind}}"`,
        `NS_ADAPTER="\${NS_ADAPTER:-${adapter}}"`,
        ...(groupBy === 'property' ? [`PROP_KEY="\${PROP_KEY:-${propKey}}"`] : []),
        `FAIL_ON_UNCOSTED=${failUncosted ? 1 : 0}`,
        '',
        'get_all "/suite-api/api/resources?adapterKind=${NS_ADAPTER}&resourceKind=${NS_KIND}" "$WORK/all.json"',
        'ns="$WORK/ns.json"',
        'jq -c \'[.[] | {id: .identifier, name: .resourceKey.name}]\' "$WORK/all.json" >"$ns"',
        'if [[ "$(jq length "$ns")" == 0 ]]; then',
        '  echo "No ${NS_ADAPTER}/${NS_KIND} objects. Resource kinds that look like namespaces or VKS:" >&2',
        '  get "/suite-api/api/adapterkinds/${NS_ADAPTER}/resourcekinds" |',
        '    jq -r \'.["resource-kind"][]? | .key | select(test("namespace|supervisor|kubernetes|vks|tkc"; "i"))\' >&2 || true',
        '  echo "Set NS_KIND (and NS_ADAPTER) to the right one and run again." >&2',
        '  exit 2',
        'fi',
        'first=$(jq -r ".[0].id" "$ns")',
        ...costKeyDiscovery('first', '^(cost|price)\\|'),
        '',
        'jq -c \'[.[].id]\' "$ns" >"$WORK/ids.json"',
        'values="$WORK/values.json"',
        'latest_map "$WORK/ids.json" "$WORK/keys.json" "$values"',
        '',
        ...(groupBy === 'property'
          ? [
              '# The roll-up property, one call per namespace (there are usually tens, not thousands).',
              'owners="$WORK/owners.json"',
              ': >"$owners.lines"',
              'for id in $(jq -r ".[].id" "$ns"); do',
              '  get "/suite-api/api/resources/${id}/properties" | jq -c --arg id "$id" --arg k "$PROP_KEY" \'{($id): ([.property[]? | select(.name == $k) | .value][0] // "(none)")}\' >>"$owners.lines"',
              'done',
              'jq -s -c \'add // {}\' "$owners.lines" >"$owners"',
            ]
          : ['owners="$WORK/owners.json"', 'echo \'{}\' >"$owners"']),
        '',
        'out="vks-cost-$(date +%Y%m).csv"',
        'jq -r --slurpfile n "$ns" --slurpfile k "$WORK/keys.json" --slurpfile o "$owners" \'',
        '  . as $v | ($k[0]) as $k | ($o[0]) as $o',
        '  | (["namespace","owner"] + $k | @csv),',
        '    ($n[0][] | . as $x | ([$x.name, ($o[$x.id] // "")] + [$k[] as $key | ($v[$x.id][$key] // "")]) | @csv)\' "$values" >"$out"',
        'echo "Wrote ${out}: $(jq length "$ns") namespace(s), $(jq length "$WORK/keys.json") cost metric(s)."',
        ...(groupBy === 'property'
          ? [
              '',
              '# Totals per owner, on the first cost key with "total" in it (VERIFY which key is the monthly total).',
              'TOTAL_KEY="${TOTAL_KEY:-$(jq -r \'[.[] | select(test("total"; "i"))][0] // .[0]\' <<<"$keys")}"',
              'echo "Per owner, on ${TOTAL_KEY}:"',
              'jq -r --slurpfile n "$ns" --slurpfile o "$owners" --arg k "$TOTAL_KEY" \'',
              '  . as $v | ($o[0]) as $o | [$n[0][] | {owner: ($o[.id] // "(none)"), cost: ($v[.id][$k] // 0)}]',
              '  | group_by(.owner) | .[] | "  \\(.[0].owner)\\t\\(map(.cost) | add)"\' "$values"',
            ]
          : []),
        '',
        'uncosted=$(jq -r --slurpfile n "$ns" \'. as $v | [$n[0][] | select(($v[.id] // {}) | [.[] | numbers] | map(select(. != 0)) | length == 0) | .name] | .[]\' "$values")',
        'if [[ -n "$uncosted" ]]; then',
        '  echo "Namespaces with no cost at all:" >&2',
        '  echo "$uncosted" | sed "s/^/  /" >&2',
        '  (( FAIL_ON_UNCOSTED )) && exit 1',
        'fi',
        'exit 0',
      ]);

      const files: Record<string, string> = {
        [`${base}.sh`]: script,
        [`${base}-showback.md`]: [
          '# VKS showback — setup',
          '',
          '1.',
          '',
          '1. Check the Supervisor and its vSphere Namespaces are collected (the script lists candidate object types if the default finds none).',
          '2. Price VKS nodes per VM class if they should be priced separately: “Showback and chargeback: a rate card” takes a price per VM class and applies it through the pricing API.',
          '3. On the Organization and Project Showback dashboards, filter by service type (Regular VMs, VKS, DSM) so VKS cost is shown once.',
          `4. Run \`${base}.sh\` and read the CSV. Namespaces with no cost mean the cost engine is not covering them — check the cost drivers for the cluster the Supervisor runs on.`,
          '5. VCF Automation 9.1 shows an upfront price when a VKS node is requested; check it against the rate you set.',
          '',
        ].join('\n'),
      };
      if (schedule) {
        files['crontab.txt'] = [
          '# Monthly VKS cost export, first of the month 06:00. Exits 1 when a namespace is uncosted, so cron mail says so.',
          '# No secret here: the script logs in from the password file.',
          `0 6 1 * * ${scheduledEnv(PLATFORM)} /opt/vcf-automation/${base}.sh >>/var/log/vcf-automation/${base}.log 2>&1`,
          '',
        ].join('\n');
      }

      return {
        platform: PLATFORM,
        title: `VKS cost per vSphere Namespace${groupBy === 'property' ? `, rolled up by ${propKey}` : ''}`,
        effect: 'read',
        trigger: { kind: schedule ? 'schedule' : 'manual', detail: schedule ? 'Monthly, from cron: the first of the month at 06:00' : 'Run by hand for each showback period', worstCase: schedule ? 'once a month' : 'whenever it is run' },
        scope: {
          what: `Every ${adapter}/${kind} object VCF Operations knows about, and its cost metrics.`,
          decidedBy: ['The resource kind, discovered or set in NS_KIND.', 'The cost and price metrics the first namespace reports, discovered from its stat keys.', ...(groupBy === 'property' ? [`The property ${propKey} on each namespace, for the roll-up.`] : [])],
          ifWrong: 'The CSV covers the wrong objects or the wrong metric, and a showback is built on it. Nothing in the platform changes.',
        },
        guardrails: [{ rule: 'It only reads', because: 'Showback is a report. Charging a tenant is a separate decision made from it, by a person.' }, ...(failUncosted ? [{ rule: 'Exits 1 when a namespace has no cost', because: 'A zero on a showback is read as “free”, not as “not measured”.' }] : [])],
        dryRun: ['Everything here is read-only. Run it once and compare one namespace against the VCF Operations interface.'],
        undo: ['Nothing to undo. Delete the CSV.'],
        told: ['Whoever reads the CSV or the cron mail; it exits 1 when a namespace is uncosted.'],
        requires: ['VCF Operations 9.1 collecting the Supervisor, with a currency set and the cost engine running.', 'jq on the machine that runs it.'],
        files,
        notes: [
          `The namespace object type (${kind}) and the property key are not in the API reference. VERIFY with GET /suite-api/api/adapterkinds/${adapter}/resourcekinds.`,
          'Cost metric keys are discovered from the first namespace’s stat keys (anything beginning cost| or price|), so the columns are whatever your release reports.',
        ],
        findings,
      };
    },
  }),
  // -------------------------------------------------------------------------
  automationBlueprint({
    id: 'vcfops_custom_profile',
    platform: PLATFORM,
    label: 'Custom profiles: how many more of a VM size fit',
    group: 'Capacity',
    description:
      'Capacity remaining is only a useful number when it is counted in the VMs people actually ask for. Custom profiles define those sizes — vCPU, memory and disk — and VCF Operations reports how many more of each fit in every cluster. This creates or updates the profiles through the API, turns them on in the capacity policy (merged into an export of the policy and read back), and writes a check that reads “VMs remaining” for each profile on the clusters you name and fails when one runs low.',
    inputs: [
      {
        id: 'profiles',
        label: 'Profiles',
        control: 'textarea',
        default: 'Small VM | 2 | 8 | 100 | ClusterComputeResource\nMedium VM | 4 | 16 | 200 | ClusterComputeResource\nLarge database | 16 | 128 | 1000 | ClusterComputeResource',
        hint: 'Name | vCPU | Memory GB | Disk GB | Object kinds',
        help: 'Object kinds the profile is counted on, comma separated: ClusterComputeResource, HostSystem, Datastore, Datacenter.',
      },
      { id: 'basis', label: 'Count against', control: 'select', options: [{ value: 'allocation', label: 'Allocation — the size as configured' }, { value: 'demand', label: 'Demand — what a VM of that size uses' }], default: 'allocation', hint: 'Match the capacity model of the policy the clusters are on' },
      { id: 'enable_in_policy', label: 'Turn the profiles on in a policy', control: 'toggle', default: true },
      { id: 'policy_name', label: 'Policy', control: 'text', default: 'Capacity — production clusters', showWhen: { input: 'enable_in_policy', equals: ['true'] } },
      { id: 'clusters', label: 'Check these clusters', control: 'text', default: 'wld01-cl01, wld02-cl01' },
      { id: 'min_remaining', label: 'Check fails when a profile has fewer than (VMs remaining)', control: 'number', default: 10, min: 0, max: 100000 },
    ],
    automation: (values: BlueprintValues, name: string): Automation => {
      const KINDS = ['ClusterComputeResource', 'HostSystem', 'Datastore', 'Datacenter'];
      const profiles = rowsOf(str(values, 'profiles', '')).map(([pname = '', cpu = '', memGb = '', diskGb = '', kinds = '']) => ({
        name: pname,
        vcpu: numOr(cpu, NaN),
        memoryGb: numOr(memGb, NaN),
        diskGb: numOr(diskGb, NaN),
        objectKinds: listOf(kinds),
      }));
      const basis = str(values, 'basis', 'allocation');
      const inPolicy = bool(values, 'enable_in_policy', true);
      const policy = str(values, 'policy_name', '');
      const clusters = listOf(str(values, 'clusters', ''));
      const minRemaining = num(values, 'min_remaining', 10);
      const base = slugOf(name || 'custom-profiles', 'custom-profiles');

      const findings: Finding[] = [];
      if (profiles.length === 0) findings.push(error('vcfops.profile.none', 'No profiles are defined.', { source: SRC }));
      profiles.forEach((profile, index) => {
        const where = `Profile row ${index + 1}${profile.name ? ` (${profile.name})` : ''}`;
        if (!profile.name) findings.push(error('vcfops.profile.name', `${where} has no name.`, { source: SRC }));
        if (!(profile.vcpu >= 1) || !(profile.memoryGb > 0) || !(profile.diskGb >= 0)) findings.push(error('vcfops.profile.size', `${where}: vCPU, memory and disk must be numbers, with at least one vCPU and some memory.`, { source: SRC }));
        const unknown = profile.objectKinds.filter((kind) => !KINDS.includes(kind));
        if (profile.objectKinds.length === 0) findings.push(error('vcfops.profile.kinds', `${where} is counted on no object kind.`, { source: SRC }));
        if (unknown.length > 0) findings.push(error('vcfops.profile.kind', `${where}: ${unknown.join(', ')} ${unknown.length === 1 ? 'is' : 'are'} not one of ${KINDS.join(', ')}.`, { source: SRC }));
        if (profile.vcpu > 128 || profile.memoryGb > 4096) findings.push(warning('vcfops.profile.huge', `${where} is larger than most hosts can place; its “VMs remaining” will read 0 or 1 everywhere.`, { source: SRC }));
      });
      if (new Set(profiles.map((profile) => profile.name.toLowerCase())).size !== profiles.length) findings.push(error('vcfops.profile.duplicate', 'Two profiles share a name; profiles are updated by name.', { source: SRC }));
      if (inPolicy && !policy.trim()) findings.push(error('vcfops.profile.no-policy', 'Turning the profiles on needs the policy the clusters are on.', { source: SRC }));
      if (inPolicy && /^default policy$/i.test(policy.trim())) findings.push(warning('vcfops.profile.default-policy', 'Changing the Default Policy changes every object no other policy covers.', { remediation: 'Turn the profiles on in the capacity policy of the clusters they are for.', source: SRC }));
      if (!inPolicy) findings.push(warning('vcfops.profile.not-enabled', 'The profiles are created but not turned on in any policy, so no cluster reports VMs remaining for them.', { source: SRC }));
      if (clusters.length === 0) findings.push(warning('vcfops.profile.no-check', 'No clusters to check, so nobody hears when a profile runs low.', { source: SRC }));

      const doc = {
        $comment: 'Custom profiles. apply-profiles.sh creates each, or updates the one with the same name, and reads it back. VERIFY: the custom profile API and its field names are not in the public API reference; the script copies the shape of a profile that already exists when there is one.',
        basis: basis.toUpperCase(),
        profiles: profiles.map((profile) => ({ name: profile.name, description: `${profile.vcpu} vCPU, ${profile.memoryGb} GB memory, ${profile.diskGb} GB disk; counted on ${basis}.`, vcpu: profile.vcpu, memoryGb: profile.memoryGb, diskGb: profile.diskGb, objectKinds: profile.objectKinds })),
      };

      const apply = [
        '#!/usr/bin/env bash',
        '# Create or update the custom profiles in custom-profiles.json, then read them back.',
        '#',
        '# VERIFY: custom profiles are served under /suite-api/internal on the builds this was',
        '# written against; set PROFILES_PATH if yours differs. When a profile already exists its',
        '# shape is copied, so field names are the platform’s. When the path is not there the',
        '# script stops and prints the interface steps instead. --dry-run changes nothing.',
        'set -euo pipefail',
        '',
        ...authPreamble(PLATFORM),
        'for tool in curl jq python3; do command -v "$tool" >/dev/null || { echo "$tool is required" >&2; exit 2; }; done',
        'EXECUTE=1',
        '[[ "${1:-}" == "--dry-run" ]] && EXECUTE=0',
        'HERE=$(cd "$(dirname "$0")" && pwd)',
        'WANT="$HERE/custom-profiles.json"',
        'WORK=$(umask 077; mktemp -d)',
        `trap 'rm -rf "$WORK"${AUTH_FILE_VAR ? `; rm -f "$${AUTH_FILE_VAR}"` : ''}' EXIT`,
        ...API_FN,
        'PROFILES_PATH="${PROFILES_PATH:-/suite-api/internal/capacity/customprofiles}"',
        '',
        'code=$(probe "$PROFILES_PATH")',
        'if [[ "$code" != 200 ]]; then',
        '  echo "GET ${PROFILES_PATH} returned HTTP ${code}: no custom profile API at that path on this build." >&2',
        '  echo "Create each by hand under Configure → Custom Profiles (Operate → Configurations in some builds):" >&2',
        '  jq -r \'.profiles[] | "  \\(.name): \\(.vcpu) vCPU, \\(.memoryGb) GB memory, \\(.diskGb) GB disk, on \\(.objectKinds | join(", "))"\' "$WANT" >&2',
        '  exit 3',
        'fi',
        'api GET "$PROFILES_PATH" >"$WORK/existing.json"',
        '',
        '# One body per profile: an existing profile of the same name, or the first existing one as',
        '# the shape, with the name and sizes set by field name; the emitted object when none exists.',
        'cat >"$WORK/profiles.py" <<\'PY\'',
        'import copy, json, re, sys',
        'existing, want, outdir = sys.argv[1:4]',
        'cur = json.load(open(existing)); want = json.load(open(want))',
        'def nodes(n):',
        '    if isinstance(n, dict):',
        '        yield n',
        '        for v in n.values(): yield from nodes(v)',
        '    elif isinstance(n, list):',
        '        for v in n: yield from nodes(v)',
        'have = [d for d in nodes(cur) if isinstance(d.get("name"), str) and any(isinstance(v, (int, float, list, dict)) for v in d.values())]',
        'def is_num(v): return isinstance(v, (int, float)) and not isinstance(v, bool)',
        'problems = []',
        'for i, p in enumerate(want["profiles"]):',
        '    same = [d for d in have if d["name"] == p["name"]]',
        '    if len(same) > 1: problems.append("%s: %d profiles have this name" % (p["name"], len(same))); continue',
        '    body, pid = None, ""',
        '    if same or have:',
        '        body = copy.deepcopy(same[0] if same else have[0])',
        '        pid = str(body.get("id") or body.get("key") or "") if same else ""',
        '        if not same:',
        '            for k in [k for k in body if re.fullmatch("id|key|uuid", k, re.I)]: del body[k]',
        '        body["name"] = p["name"]',
        '        if isinstance(body.get("description"), str): body["description"] = p["description"]',
        '        for label, regex, value in (("vCPU", "cpu", p["vcpu"]), ("memory", "mem", p["memoryGb"]), ("disk", "disk|storage", p["diskGb"])):',
        '            hits = [(d, k) for d in nodes(body) for k, v in d.items() if is_num(v) and re.search(regex, k, re.I)]',
        '            if len(hits) != 1:',
        '                hits = [(d, k) for d in nodes(body) if re.search(regex, str(d.get("key") or d.get("metricKey") or d.get("name") or ""), re.I) for k, v in d.items() if is_num(v) and re.search("value|size|amount", k, re.I)]',
        '            if len(hits) != 1: problems.append("%s: %s field matched %d places" % (p["name"], label, len(hits))); continue',
        '            d, k = hits[0]; d[k] = value',
        '    else:',
        '        body = {k: v for k, v in p.items()}',
        '        body["basis"] = want.get("basis")',
        '    json.dump(body, open("%s/%d.json" % (outdir, i), "w"))',
        '    print("%d\\t%s\\t%s" % (i, pid, p["name"]))',
        'for x in problems: print("REFUSED: " + x, file=sys.stderr)',
        'sys.exit(3 if problems else 0)',
        'PY',
        'python3 "$WORK/profiles.py" "$WORK/existing.json" "$WANT" "$WORK" >"$WORK/plan.tsv"',
        '',
        'while IFS=$\'\\t\' read -r i id pname; do',
        '  if (( ! EXECUTE )); then echo "DRY RUN: would $([[ -n "$id" ]] && echo "update ${id}" || echo create) profile \\"${pname}\\":"; cat "$WORK/$i.json"; echo; continue; fi',
        '  if [[ -n "$id" ]]; then',
        '    api PUT "${PROFILES_PATH}/${id}" -H "Content-Type: application/json" --data-binary @"$WORK/$i.json" >/dev/null',
        '  else',
        '    api POST "$PROFILES_PATH" -H "Content-Type: application/json" --data-binary @"$WORK/$i.json" >/dev/null',
        '  fi',
        '  echo "Profile \\"${pname}\\": $([[ -n "$id" ]] && echo updated || echo created)."',
        'done <"$WORK/plan.tsv"',
        'if (( ! EXECUTE )); then echo "Dry run: nothing was changed. Run it without --dry-run to apply."; exit 0; fi',
        '',
        'api GET "$PROFILES_PATH" >"$WORK/after.json"',
        'missing=$(jq -r --slurpfile w "$WANT" \'[.. | objects | .name? | strings] as $have | $w[0].profiles[].name | select(. as $n | $have | index($n) | not)\' "$WORK/after.json")',
        'if [[ -n "$missing" ]]; then echo "These profiles do not read back:" >&2; echo "$missing" >&2; exit 1; fi',
        'echo "Every profile reads back.' + (inPolicy ? ' Next: ./merge-policy.sh turns them on in the policy.' : '') + '"',
        '',
      ].join('\n');

      const overridesFile = `${base}-policy-overrides.xml`;
      const xmlAttr = (text: string): string => text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const kindsUsed = [...new Set(profiles.flatMap((profile) => profile.objectKinds.filter((kind) => KINDS.includes(kind))))];
      const overrides = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<!-- The custom profiles turned on in the policy. VERIFY the element names against an export of a',
        '     policy where one custom profile was turned on by hand: merge-policy.sh stops before importing',
        '     an element the export has nowhere, and puts the policy back if a value does not read back. -->',
        '<PolicyOverrides>',
        '    <PackageSettings>',
        ...kindsUsed.flatMap((kind) => [
          `        <CustomProfiles adapterKind="VMWARE" resourceKind="${kind}">`,
          ...profiles.filter((profile) => profile.objectKinds.includes(kind)).map((profile) => `            <CustomProfile name="${xmlAttr(profile.name)}" enabled="true"/>`),
          '        </CustomProfiles>',
        ]),
        '    </PackageSettings>',
        '</PolicyOverrides>',
        '',
      ].join('\n');

      const check = readScript('vcf-operations', `VMs remaining per custom profile on ${clusters.join(', ') || 'no cluster'}.`, [
        ...POST_QUERY,
        `CLUSTERS=(${clusters.map((c) => JSON.stringify(c)).join(' ')})`,
        `MIN_REMAINING=${minRemaining}`,
        'low=0',
        'for CLUSTER in "${CLUSTERS[@]}"; do',
        '  id=$(get "/suite-api/api/resources?adapterKind=VMWARE&resourceKind=ClusterComputeResource&name=$(jq -rn --arg n "$CLUSTER" \'$n|@uri\')" |',
        '    jq -r --arg n "$CLUSTER" \'[.resourceList[]? | select(.resourceKey.name == $n)][0].identifier // empty\')',
        '  [[ -n "$id" ]] || { echo "No cluster named ${CLUSTER}." >&2; exit 2; }',
        '  # Profile keys are discovered: every capacity stat this cluster reports about a profile.',
        '  keys=$(get "/suite-api/api/resources/${id}/statkeys" | jq -c \'[.["stat-key"][]?.key | select(test("profile"; "i") and test("remaining"; "i"))] | unique\')',
        '  if [[ "$(jq length <<<"$keys")" == 0 ]]; then echo "${CLUSTER}: no custom profile metrics yet. Profiles appear after the policy turns them on and the next capacity calculation." >&2; low=1; continue; fi',
        '  vals=$(jq -n --arg id "$id" --argjson k "$keys" \'{resourceId: [$id], statKey: $k, maxSamples: 1}\' |',
        `    post /suite-api/api/resources/stats/latest/query | jq -c --arg id "$id" '(${LATEST_TO_MAP})[$id] // {}')`,
        '  echo "${CLUSTER}:"',
        '  jq -r \'to_entries[] | "  \\(.key)\\t\\(.value)"\' <<<"$vals"',
        '  under=$(jq -r --argjson m "$MIN_REMAINING" \'[to_entries[] | select((.value | numbers) < $m) | .key] | .[]\' <<<"$vals")',
        '  if [[ -n "$under" ]]; then echo "${CLUSTER}: fewer than ${MIN_REMAINING} remaining for:" >&2; echo "$under" | sed "s/^/  /" >&2; low=1; fi',
        'done',
        'exit "$low"',
      ]);

      const files: Record<string, string> = {
        'custom-profiles.json': `${JSON.stringify(doc, null, 2)}\n`,
        'apply-profiles.sh': apply,
        ...(clusters.length > 0 ? { 'profiles-remaining.sh': check, 'crontab.txt': ['# VMs remaining per profile, every Monday 07:00. Exits 1 when a profile runs low, so cron mail says so.', '# No secret here: the script logs in from its password file.', `0 7 * * 1 ${scheduledEnv(PLATFORM)} /opt/vcf-automation/profiles-remaining.sh >>/var/log/vcf-automation/profiles-remaining.log 2>&1`, ''].join('\n') } : {}),
        ...(inPolicy ? { [overridesFile]: overrides, 'merge-policy.sh': policySectionMergeScript(overridesFile, policy, 'custom profiles') } : {}),
      };
      files['IMPORT.md'] = importMd({
        title: `${profiles.length} custom profile${profiles.length === 1 ? '' : 's'}`,
        intro: ['Custom profiles are not a file VCF Operations imports: apply-profiles.sh writes them through the API, and merge-policy.sh turns them on in the policy.'],
        steps: [
          { heading: 'The profiles', files: ['custom-profiles.json', 'apply-profiles.sh'], how: ['./apply-profiles.sh — creates each profile or updates the one with the same name, then reads them back. --dry-run prints each body and changes nothing.'], verify: ['the custom profile path (PROFILES_PATH). Without it the script prints the interface steps instead.'] },
          ...(inPolicy ? [{ heading: `Turn them on in "${policy}"`, files: [overridesFile, 'merge-policy.sh'], how: ['./merge-policy.sh — exports the policy (the undo), merges the profiles in, imports it and reads every value back. --dry-run stops before the import.'], verify: ['the element names in the overrides file; the script refuses unknown ones unless ALLOW_NEW=1, and restores the policy if a value does not stick.'] }] : []),
          ...(clusters.length > 0 ? [{ heading: 'The weekly check', files: ['profiles-remaining.sh', 'crontab.txt'], how: ['Install the script under /opt/vcf-automation and the crontab line. It exits 1 when a profile has fewer than the minimum remaining.'] }] : []),
        ],
      });

      return {
        platform: PLATFORM,
        title: `${profiles.length} custom profile${profiles.length === 1 ? '' : 's'} (${profiles.map((profile) => profile.name).join(', ') || 'none'})${inPolicy ? ` on in "${policy}"` : ''}`,
        effect: 'reversible',
        trigger: { kind: 'manual', detail: `Applied once as a change; ${clusters.length > 0 ? 'the check runs weekly from cron' : 'nothing runs on a schedule'}.`, worstCase: clusters.length > 0 ? 'a report a week' : 'once' },
        scope: {
          what: `The custom profiles named, and — once turned on — the capacity figures of every ${kindsUsed.join(', ') || 'object'} the policy${inPolicy ? ` "${policy}"` : ''} covers.`,
          decidedBy: ['The profiles, by name.', inPolicy ? `The groups "${policy}" is assigned to, and its priority.` : 'No policy: nothing counts them yet.', 'The capacity model of that policy, which decides whether a profile is counted on allocation or demand.'],
          ifWrong: 'VMs remaining is counted in a size nobody asks for, and a cluster reads as having room it does not have for the VMs people do ask for. Nothing in the inventory changes.',
        },
        guardrails: [
          { rule: 'Profiles are updated by name, never duplicated, and read back', because: 'Two profiles with one name report two different answers to the same question.' },
          { rule: 'The policy change is merged into an export, checked, and reverted if a value does not stick', because: 'A policy import that carried only these lines would drop every other override the policy has.' },
          { rule: `The check fails when a profile has fewer than ${minRemaining} remaining`, because: 'A number on a dashboard is read when someone looks; an exit 1 is read when it matters.' },
        ],
        dryRun: ['apply-profiles.sh --dry-run prints each body it would send.', ...(inPolicy ? ['merge-policy.sh --dry-run prints what it would change and writes import/policy-merged.zip without importing it.'] : [])],
        undo: ['Delete the profiles under Configure → Custom Profiles (or DELETE at the profile path).', ...(inPolicy ? ['Import the policy-before-<time>.zip merge-policy.sh saved.'] : [])],
        told: clusters.length > 0 ? ['Cron mail from profiles-remaining.sh, weekly, when a profile runs low.'] : ['Nobody: the figures are on the capacity pages only.'],
        requires: ['curl, jq and python3 on the machine that runs the scripts.', ...(inPolicy ? [`The policy "${policy}" (found by name, or set POLICY_ID).`] : []), ...(clusters.length > 0 ? [`The clusters ${clusters.join(', ')} collected by VCF Operations.`] : [])],
        files,
        notes: [
          'A profile is counted on the object kinds it is enabled for: ClusterComputeResource for “how many more fit in this cluster”, Datastore for storage-only sizes.',
          'VERIFY: custom profiles have no public API. apply-profiles.sh uses /suite-api/internal/capacity/customprofiles by default, copies the shape of an existing profile where there is one, and stops with the interface steps when the path is not there.',
          'Figures appear after the policy turns the profiles on and the next capacity calculation — not immediately.',
        ],
        findings,
      };
    },
  }),
].map(withScriptsImportMd);
