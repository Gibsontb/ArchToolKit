/**
 * VCF Operations: the policy editor.
 *
 * A policy is where an alert is turned on, a metric collected, a capacity
 * buffer set and a workload balanced — and it is one XML file per policy that
 * holds every override of its parent. So a change is never "import this
 * fragment": it is export the policy as it is, merge the few elements this
 * change is about into it, import the whole thing back, and keep the export
 * as the undo. That is what merge-policy.sh does here, for every section, and
 * then assigns the policy to its custom groups.
 *
 * Element names outside <Alerts> are not in any published schema. The merge
 * refuses to add a section the export has never contained (unless told to),
 * so a guessed name stops the run instead of being imported silently.
 */

import { bool, num, str, type BlueprintValues } from '../../kit/blueprint.ts';
import { error, info, warning, type Finding } from '../../core/findings.ts';
import { automationBlueprint, type AutomationBlueprint } from '../from-automation.ts';
import { listOf, slugOf, type Automation } from '../automation.ts';
import { authHeader } from '../apply.ts';
import { FORMAT_SOURCES, importMd, xe } from '../vcfops-import.ts';
import { kindOf, opsScript, rowsOf, sh } from './vcf-ops-setup-lib.ts';

const PLATFORM = 'vcf-operations' as const;
const SRC = 'ArchToolKit';

const SECTIONS: readonly { value: string; label: string }[] = [
  { value: 'alerts', label: 'Alerts: enable, disable, automate' },
  { value: 'symptoms', label: 'Symptoms: enable, disable, threshold overrides' },
  { value: 'metrics', label: 'Metrics and properties: collect, KPI, super metrics' },
  { value: 'capacity', label: 'Capacity: model, buffers, time remaining' },
  { value: 'workload', label: 'Workload Automation: balance, consolidation, headroom' },
  { value: 'profiles', label: 'Custom profiles' },
  { value: 'groups', label: 'Assign to custom groups' },
];

/** The python that merges an overrides file into an exported policy, element by element. */
function mergePython(): string[] {
  return [
    'import re, sys, zipfile, xml.etree.ElementTree as ET',
    'src, overrides, out, allow_new = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4] == "1"',
    'with zipfile.ZipFile(src) as z:',
    '    names = z.namelist()',
    '    xmls = [n for n in names if n.lower().endswith(".xml")]',
    '    if len(xmls) != 1:',
    '        sys.exit("expected one XML file in the policy export, found %r" % xmls)',
    '    name = xmls[0]',
    '    raw = z.read(name)',
    '    others = {n: z.read(n) for n in names if n != name}',
    'for prefix, uri in re.findall(r\'xmlns(?::([A-Za-z_][\\w.-]*))?="([^"]+)"\', raw.decode("utf-8")):',
    '    ET.register_namespace(prefix or "", uri)',
    'root = ET.fromstring(raw)',
    'def local(tag):',
    '    return tag.split("}")[-1]',
    'def ns_of(el):',
    '    return el.tag[: el.tag.index("}") + 1] if el.tag.startswith("{") else ""',
    'policies = root.findall(".//{*}Policy")',
    'if len(policies) != 1:',
    '    sys.exit("expected exactly one <Policy> in the export, found %d; export one policy by its id" % len(policies))',
    'policy = policies[0]',
    'present = {local(e.tag) for e in root.iter()}',
    '# <Alerts>/<Alert> are the documented shape; anything else must already be in the export.',
    'KNOWN = {"Alerts", "Alert"}',
    'IDENT = ("id", "key", "name", "adapterKind", "resourceKind")',
    'def ident(el):',
    '    return [(k, el.get(k)) for k in IDENT if el.get(k) is not None]',
    'changes, unknown = [], set()',
    'def merge(target, over, path):',
    '    for k, v in over.attrib.items():',
    '        if target.get(k) != v:',
    '            changes.append("%s @%s: %s -> %s" % (path, k, target.get(k), v))',
    '            target.set(k, v)',
    '    for child in over:',
    '        tag = local(child.tag)',
    '        match = None',
    '        for cand in target:',
    '            if local(cand.tag) == tag and all(cand.get(k) == v for k, v in ident(child)):',
    '                match = cand',
    '                break',
    '        where = "%s/%s%s" % (path, tag, dict(ident(child)) if ident(child) else "")',
    '        if match is None:',
    '            if tag not in present and tag not in KNOWN and not allow_new:',
    '                unknown.add(tag)',
    '                continue',
    '            match = ET.SubElement(target, ns_of(target) + tag, dict(ident(child)))',
    '            changes.append("%s: added" % where)',
    '        merge(match, child, where)',
    'package = policy.find("{*}PackageSettings")',
    'if package is None:',
    '    package = ET.SubElement(policy, ns_of(policy) + "PackageSettings", {})',
    'over_package = ET.parse(overrides).getroot().find(".//PackageSettings")',
    'if over_package is None:',
    '    sys.exit("the overrides file has no <PackageSettings>")',
    'merge(package, over_package, "PackageSettings")',
    'if unknown:',
    '    print("VERIFY: the export has no %s element, so the name this change uses is unconfirmed." % ", ".join(sorted(unknown)), file=sys.stderr)',
    '    print("Set one value in that section once in the interface, export the policy, and compare; or re-run with --allow-new.", file=sys.stderr)',
    '    sys.exit(3)',
    'for line in changes:',
    '    print(line)',
    'data = ET.tostring(root, encoding="utf-8", xml_declaration=True)',
    'with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:',
    '    z.writestr(name, data)',
    '    for n, b in others.items():',
    '        z.writestr(n, b)',
    'print("%d setting(s) changed; wrote %s" % (len(changes), out))',
  ];
}

export const VCF_OPS_POLICY_EDITOR: readonly AutomationBlueprint[] = [
  automationBlueprint({
    id: 'vcfops_policy_editor',
    platform: PLATFORM,
    label: 'Edit a policy: alerts, symptoms, metrics, capacity, workload, groups',
    group: 'Policy',
    description:
      'Creates the policy if it does not exist (under a parent), then exports it, merges the sections you fill in — alerts on or off and automated, symptom thresholds, metrics and properties collected or KPI, super metrics, capacity model and buffers, Workload Automation balance and headroom, custom profiles — imports it back, and assigns it to its custom groups. The export is kept as the undo.',
    inputs: [
      { id: 'policy_name', label: 'Policy', control: 'text', default: 'Production Policy' },
      { id: 'create', label: 'Create it if it does not exist', control: 'toggle', default: true },
      { id: 'parent', label: 'Parent policy (when created)', control: 'text', default: 'Default Policy', showWhen: { input: 'create', equals: ['true'] } },
      { id: 'description', label: 'Description', control: 'text', default: 'Production thresholds and alerting' },
      { id: 'sections', label: 'Sections to change', control: 'checklist', options: SECTIONS, default: 'alerts,symptoms,metrics,groups' },
      {
        id: 'alert_rows',
        label: 'Alerts',
        control: 'textarea',
        default: 'VMWARE/HostSystem | AlertDefinition-VMWARE-HostMemContentionManyVMs | on | no\nVMWARE/Datastore | AlertDefinition-VMWARE-DatastoreUsage | on | no',
        hint: 'Object kind | Alert definition id | State | Automate',
      },
      {
        id: 'symptom_rows',
        label: 'Symptoms',
        control: 'textarea',
        default: 'VMWARE/HostSystem | SymptomDefinition-VMWARE-HostMemUsageHigh | on | 90',
        hint: 'Object kind | Symptom definition id | State | Threshold (empty keeps it)',
      },
      {
        id: 'metric_rows',
        label: 'Metrics, properties and super metrics',
        control: 'textarea',
        default: 'VMWARE/VirtualMachine | cpu|readyPct | on\nVMWARE/HostSystem | mem|host_usagePct | kpi',
        hint: 'Object kind | Key (a super metric is Super Metric|sm_<id>) | State: on, off or kpi',
      },
      {
        id: 'cap_model',
        label: 'Capacity model',
        control: 'select',
        options: [
          { value: 'DEMAND', label: 'Demand' },
          { value: 'ALLOCATION', label: 'Allocation (with overcommit ratios)' },
          { value: 'BOTH', label: 'Demand and allocation' },
        ],
        default: 'DEMAND',
      },
      {
        id: 'cap_risk',
        label: 'Time remaining risk level',
        control: 'select',
        options: [
          { value: 'CONSERVATIVE', label: 'Conservative (peak demand)' },
          { value: 'AGGRESSIVE', label: 'Aggressive (average demand)' },
        ],
        default: 'CONSERVATIVE',
      },
      { id: 'cap_buffer_cpu', label: 'CPU buffer %', control: 'number', default: 10, min: 0, max: 50 },
      { id: 'cap_buffer_mem', label: 'Memory buffer %', control: 'number', default: 10, min: 0, max: 50 },
      { id: 'cap_buffer_disk', label: 'Disk buffer %', control: 'number', default: 10, min: 0, max: 50 },
      { id: 'cap_critical_days', label: 'Time remaining is critical below (days)', control: 'number', default: 60, min: 1, max: 365 },
      { id: 'cap_cpu_ratio', label: 'vCPU : pCPU overcommit', control: 'number', default: 4, min: 1, max: 32, showWhen: { input: 'cap_model', equals: ['ALLOCATION', 'BOTH'] } },
      { id: 'cap_mem_ratio', label: 'Memory overcommit', control: 'number', default: 1, min: 1, max: 4, showWhen: { input: 'cap_model', equals: ['ALLOCATION', 'BOTH'] } },
      {
        id: 'wa_balance',
        label: 'Workload balance',
        control: 'select',
        options: [
          { value: 'CONSERVATIVE', label: 'Conservative' },
          { value: 'MODERATE', label: 'Moderate' },
          { value: 'AGGRESSIVE', label: 'Aggressive — see the finding' },
        ],
        default: 'MODERATE',
      },
      {
        id: 'wa_consolidate',
        label: 'Consolidation',
        control: 'select',
        options: [
          { value: 'OFF', label: 'Off' },
          { value: 'CONSERVATIVE', label: 'Conservative' },
          { value: 'AGGRESSIVE', label: 'Aggressive' },
        ],
        default: 'OFF',
      },
      { id: 'wa_headroom', label: 'Cluster headroom %', control: 'number', default: 10, min: 0, max: 50 },
      { id: 'wa_storage', label: 'Storage-based eviction (9.1)', control: 'toggle', default: false },
      { id: 'profiles', label: 'Custom profiles', control: 'textarea', default: 'Small VM | 2 | 4 | 60\nLarge VM | 8 | 32 | 200', hint: 'Name | vCPU | Memory GB | Disk GB' },
      { id: 'groups', label: 'Assign to custom groups', control: 'text', default: 'Production VMs, Production hosts', hint: 'Comma-separated custom group names' },
      { id: 'priority', label: 'Priority (1 is highest)', control: 'number', default: 1, min: 1, max: 100 },
    ],
    automation: (values: BlueprintValues, name: string): Automation => {
      const policy = str(values, 'policy_name', 'Production Policy');
      const create = bool(values, 'create', true);
      const parent = str(values, 'parent', 'Default Policy');
      const description = str(values, 'description', '');
      const sections = new Set(listOf(str(values, 'sections', '')));
      const alertRows = sections.has('alerts') ? rowsOf(str(values, 'alert_rows', '')) : [];
      const symptomRows = sections.has('symptoms') ? rowsOf(str(values, 'symptom_rows', '')) : [];
      const metricRows = sections.has('metrics') ? rowsOf(str(values, 'metric_rows', '')) : [];
      const profileRows = sections.has('profiles') ? rowsOf(str(values, 'profiles', '')) : [];
      const groups = sections.has('groups') ? listOf(str(values, 'groups', '')) : [];
      const priority = num(values, 'priority', 1);
      const capModel = str(values, 'cap_model', 'DEMAND');
      const balance = str(values, 'wa_balance', 'MODERATE');
      const consolidate = str(values, 'wa_consolidate', 'OFF');
      const base = slugOf(name || policy, 'policy-change');

      const findings: Finding[] = [];
      const onOff = (text: string | undefined) => /^(on|true|enabled?|yes)$/i.test(text ?? '');
      const isOnOff = (text: string | undefined) => /^(on|off|true|false|enabled?|disabled?|yes|no)$/i.test(text ?? '');
      for (const row of alertRows) {
        if (row.length < 3 || !row[1] || !isOnOff(row[2])) findings.push(error('vcfops.policyed.bad-alert-row', `Alert row "${row.join(' | ')}" needs Object kind | Alert definition id | on/off | yes/no.`, { source: SRC }));
      }
      for (const row of symptomRows) {
        if (row.length < 3 || !row[1] || !isOnOff(row[2]) || (row[3] && !Number.isFinite(Number(row[3])))) findings.push(error('vcfops.policyed.bad-symptom-row', `Symptom row "${row.join(' | ')}" needs Object kind | Symptom definition id | on/off | a numeric threshold or nothing.`, { source: SRC }));
      }
      for (const row of metricRows) {
        if (row.length < 3 || !row[1] || !/^(on|off|kpi)$/i.test(row[2] ?? '')) findings.push(error('vcfops.policyed.bad-metric-row', `Metric row "${row.join(' | ')}" needs Object kind | key | on, off or kpi.`, { source: SRC }));
      }
      for (const row of profileRows) {
        if (row.length < 4 || !row[0] || row.slice(1, 4).some((cell) => !(Number(cell) > 0))) findings.push(error('vcfops.policyed.bad-profile-row', `Profile row "${row.join(' | ')}" needs Name | vCPU | Memory GB | Disk GB, all positive.`, { source: SRC }));
      }
      const automated = alertRows.filter((row) => /^(yes|true|on)$/i.test(row[3] ?? ''));
      if (automated.length > 0) {
        findings.push(warning('vcfops.policyed.automate', `${automated.length} alert(s) will run their recommended action with nobody approving it.`, { remediation: 'Check the action, its account’s rights and the groups this policy covers before turning automation on. The alert action blueprint has the guardrails for it.', source: SRC }));
      }
      if (/^default policy$/i.test(policy)) {
        findings.push(warning('vcfops.policyed.default', 'This changes the default policy, which covers every object no other policy claims — including objects added next year.', { remediation: 'Make a child policy and assign it to the groups this change is meant for.', source: SRC }));
      }
      if (sections.size === 0 || (alertRows.length + symptomRows.length + metricRows.length + profileRows.length + groups.length === 0 && !sections.has('capacity') && !sections.has('workload'))) {
        findings.push(error('vcfops.policyed.nothing', 'Nothing to change: no section is ticked, or the ticked ones are empty.', { source: SRC }));
      }
      if (sections.has('groups') && groups.length === 0) {
        findings.push(warning('vcfops.policyed.no-groups', 'Assign is ticked with no groups, so the policy applies to nothing it is not already on.', { source: SRC }));
      }
      if (sections.has('workload') && balance === 'AGGRESSIVE') {
        findings.push(warning('vcfops.policyed.aggressive', 'Aggressive balancing moves VMs whenever the imbalance is small, which is a lot of vMotion for a small gain.', { remediation: 'Moderate is where most estates stay.', source: SRC }));
      }
      if (sections.has('capacity') && (num(values, 'cap_buffer_cpu', 10) === 0 || num(values, 'cap_buffer_mem', 10) === 0)) {
        findings.push(info('vcfops.policyed.no-buffer', 'A zero buffer means time remaining counts down to the last megahertz, which is not the day you want to find out.', { source: SRC }));
      }

      // The change, as the policy XML would hold it.
      const byKind = (rows: string[][]) => {
        const out = new Map<string, string[][]>();
        for (const row of rows) {
          const kind = row[0] || 'VMWARE/VirtualMachine';
          out.set(kind, [...(out.get(kind) ?? []), row]);
        }
        return out;
      };
      const kindAttrs = (kind: string) => {
        const k = kindOf(kind);
        return `adapterKind="${xe(k.adapterKind)}" resourceKind="${xe(k.resourceKind)}"`;
      };
      const lines: string[] = [];
      for (const [kind, rows] of byKind(alertRows)) {
        lines.push(`                <Alerts ${kindAttrs(kind)}>`);
        for (const row of rows) lines.push(`                    <Alert id="${xe(row[1] ?? '')}" enabled="${onOff(row[2])}" automate="${/^(yes|true|on)$/i.test(row[3] ?? '')}"/>`);
        lines.push('                </Alerts>');
      }
      for (const [kind, rows] of byKind(symptomRows)) {
        lines.push(`                <Symptoms ${kindAttrs(kind)}>`);
        for (const row of rows) lines.push(`                    <Symptom id="${xe(row[1] ?? '')}" enabled="${onOff(row[2])}"${row[3] ? ` threshold="${xe(row[3])}"` : ''}/>`);
        lines.push('                </Symptoms>');
      }
      for (const [kind, rows] of byKind(metricRows)) {
        lines.push(`                <AttributeKinds ${kindAttrs(kind)}>`);
        for (const row of rows) lines.push(`                    <AttributeKind key="${xe(row[1] ?? '')}" enabled="${!/^off$/i.test(row[2] ?? '')}" kpi="${/^kpi$/i.test(row[2] ?? '')}"/>`);
        lines.push('                </AttributeKinds>');
      }
      if (sections.has('capacity')) {
        lines.push(
          `                <CapacityAnalysis adapterKind="VMWARE" resourceKind="ClusterComputeResource" model="${capModel}" riskLevel="${str(values, 'cap_risk', 'CONSERVATIVE')}" cpuBufferPercent="${num(values, 'cap_buffer_cpu', 10)}" memoryBufferPercent="${num(values, 'cap_buffer_mem', 10)}" diskBufferPercent="${num(values, 'cap_buffer_disk', 10)}" timeRemainingCriticalDays="${num(values, 'cap_critical_days', 60)}"${capModel === 'DEMAND' ? '' : ` cpuOvercommitRatio="${num(values, 'cap_cpu_ratio', 4)}" memoryOvercommitRatio="${num(values, 'cap_mem_ratio', 1)}"`}/>`,
        );
      }
      if (sections.has('workload')) {
        lines.push(`                <WorkloadAutomation adapterKind="VMWARE" resourceKind="ClusterComputeResource" balance="${balance}" consolidation="${consolidate}" headroomPercent="${num(values, 'wa_headroom', 10)}" storageBasedEviction="${bool(values, 'wa_storage', false)}"/>`);
      }
      if (profileRows.length > 0) {
        lines.push('                <CustomProfiles>');
        for (const row of profileRows) lines.push(`                    <CustomProfile name="${xe(row[0] ?? '')}" vcpu="${xe(row[1] ?? '')}" memoryMB="${Number(row[2] ?? 0) * 1024}" diskGB="${xe(row[3] ?? '')}"/>`);
        lines.push('                </CustomProfiles>');
      }
      const xml = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<PolicyContent>',
        '    <Policies>',
        `        <Policy name="${xe(policy)}" description="${xe(description)}">`,
        '            <PackageSettings>',
        ...lines,
        '            </PackageSettings>',
        '        </Policy>',
        '    </Policies>',
        '</PolicyContent>',
        '',
      ].join('\n');

      const script = opsScript({
        about: [
          `Edit the policy "${policy}": ${create ? `create it under "${parent}" if it is not there, ` : ''}export it, merge`,
          `${base}.xml into the export, import the merged policy and assign it to its groups.`,
          'A policy XML holds every override the policy has, so this never imports the change on',
          'its own. The export is kept beside this script as policy-before-<time>.zip: importing',
          'it back the same way is the undo.',
          'Merges sections the export has never contained only with --allow-new.',
          'Imports with POST /suite-api/api/policies/import?forceImport=true (multipart policy=@<zip>).',
        ],
        tools: ['python3'],
        body: [
          'ALLOW_NEW=0',
          'for arg in "$@"; do case "$arg" in --allow-new) ALLOW_NEW=1 ;; esac; done',
          'mkdir -p "$HERE/import"',
          `NAME=${sh(policy)}`,
          '',
          '# 1. The policy, created if asked and missing.',
          'POLICY_ID=$(api GET policies | jq -r --arg n "$NAME" \'[(.policySummaries[]?, ."policy-summaries"[]?) | select(.name == $n) | .id] | .[0] // empty\')',
          'if [[ -z "$POLICY_ID" ]]; then',
          ...(create
            ? [
                `  PARENT_ID=$(policy_id ${sh(parent)})`,
                `  POLICY_ID=$(jq -n --arg n "$NAME" --arg d ${sh(description)} --arg p "$PARENT_ID" '{name: $n, description: $d, parentPolicyId: $p}' | send POST policies | jq -r '.id // empty')`,
                '  [[ -n "$POLICY_ID" ]] || { echo "VERIFY: POST /suite-api/api/policies returned no id. Create the policy under Infrastructure Operations → Configurations → Policies → Add, then run again." >&2; exit 1; }',
                '  if (( DRY_RUN )); then echo "DRY RUN: the policy does not exist yet, so there is nothing to export and merge until it is created."; exit 0; fi',
                '  echo "Created ${NAME} (${POLICY_ID})."',
              ]
            : ['  echo "No policy named ${NAME}." >&2', '  exit 1']),
          'fi',
          '',
          '# 2. Export (the undo), merge, and show what changes.',
          'BEFORE="$HERE/policy-before-$(date +%Y%m%d-%H%M%S).zip"',
          `curl -sS -f "https://\${VCFOPS_HOST}/suite-api/api/policies/export?id=\${POLICY_ID}" -H "${authHeader(PLATFORM)}" -H "Accept: application/zip" -o "$BEFORE"`,
          'echo "Exported the policy as it is now: $BEFORE (the undo)"',
          `python3 - "$BEFORE" "$HERE/${base}.xml" "$HERE/import/policy-merged.zip" "$ALLOW_NEW" <<'PY'`,
          ...mergePython(),
          'PY',
          '',
          '# 3. Import the whole merged policy.',
          'if (( DRY_RUN )); then',
          '  echo "DRY RUN: would POST import/policy-merged.zip to https://${VCFOPS_HOST}/suite-api/api/policies/import?forceImport=true"',
          'else',
          `  curl -sS -f -X POST "https://\${VCFOPS_HOST}/suite-api/api/policies/import?forceImport=true" -H "${authHeader(PLATFORM)}" -H "Accept: application/json" -F "policy=@$HERE/import/policy-merged.zip;type=application/zip"`,
          '  echo',
          '  echo "Imported. Undo: POST $BEFORE to the same endpoint the same way."',
          'fi',
          ...(groups.length > 0
            ? [
                '',
                '# 4. Assign it: each custom group carries the id of its policy.',
                ...groups.flatMap((group) => [
                  `GID=$(group_id ${sh(group)})`,
                  'api GET "resources/groups/${GID}" | jq --arg p "$POLICY_ID" \'.policy = $p\' | send PUT resources/groups >/dev/null',
                  `echo "Assigned ${group.replace(/"/g, '')} to ${policy.replace(/"/g, '')}."`,
                ]),
              ]
            : []),
          '',
          `echo "Priority: put \\"${policy.replace(/"/g, '')}\\" at position ${priority} under Infrastructure Operations → Configurations → Policies → Policy Priority. No documented API call reorders policies."`,
        ],
        undo: 'POST policy-before-<time>.zip to /suite-api/api/policies/import?forceImport=true (multipart field policy); set each group back to its previous policy in the group editor.',
      });

      const what = [
        alertRows.length > 0 ? `${alertRows.length} alert(s)` : '',
        symptomRows.length > 0 ? `${symptomRows.length} symptom(s)` : '',
        metricRows.length > 0 ? `${metricRows.length} metric(s)` : '',
        sections.has('capacity') ? 'capacity' : '',
        sections.has('workload') ? 'Workload Automation' : '',
        profileRows.length > 0 ? `${profileRows.length} profile(s)` : '',
      ].filter(Boolean);

      return {
        platform: PLATFORM,
        title: `${policy} — ${what.join(', ') || 'no settings'}${groups.length > 0 ? `, on ${groups.join(', ')}` : ''}`,
        effect: 'reversible',
        trigger: { kind: 'manual', detail: 'Applied once, by a person, as a change.' },
        scope: {
          what: `Every object the policy "${policy}" applies to${groups.length > 0 ? ` — the members of ${groups.join(', ')} once assigned` : ''}.`,
          decidedBy: [
            groups.length > 0 ? `The custom groups ${groups.join(', ')}, and whoever edits their membership.` : `The custom groups "${policy}" is already assigned to.`,
            `The policy priority order — a higher-priority policy on the same object wins; this one is meant for position ${priority}.`,
            'The settings merged here; everything else the policy inherits from its parent or already overrides is kept as it is.',
          ],
          ifWrong: 'Alerts start or stop firing, thresholds and capacity figures change and VMs may move, across every object the policy covers — and nothing reports that a policy changed.',
        },
        guardrails: [
          { rule: 'Export before anything changes, and keep it', because: 'The export is the only undo; the interface does not show a policy’s previous values.' },
          { rule: 'Merge into the export, never import a fragment', because: 'A policy file holds all of a policy’s overrides; importing a fragment drops every other one.' },
          { rule: 'Only sections already in the export are merged, unless --allow-new', because: 'Element names outside <Alerts> are unpublished; a guessed one stops the run instead of being imported.' },
          { rule: 'Every change is printed before the import', because: 'The printed list is the review.' },
        ],
        dryRun: ['./merge-policy.sh --dry-run exports the policy, writes import/policy-merged.zip, prints every setting it changes, and stops before the import.'],
        undo: ['Re-import policy-before-<time>.zip: POST /suite-api/api/policies/import?forceImport=true, multipart field policy.', 'Set each group back to its previous policy.'],
        told: ['Nobody automatically. A policy change is silent, which is why it belongs in a change record.'],
        requires: [create ? `The parent policy "${parent}" (only if "${policy}" has to be created).` : `The policy "${policy}".`, ...(groups.length > 0 ? [`The custom groups ${groups.join(', ')}.`] : []), 'python3, curl and jq on the host that runs it.'],
        files: {
          [`${base}.xml`]: xml,
          'merge-policy.sh': script,
          'IMPORT.md': importMd({
            title: `the change to the policy "${policy}"`,
            steps: [
              {
                heading: 'Export, merge, import, assign',
                files: [`${base}.xml`, 'merge-policy.sh'],
                how: [
                  `${base}.xml is the change, not a policy to import on its own.`,
                  './merge-policy.sh (add --dry-run first to preview) creates the policy if needed, exports it, merges the change, writes import/policy-merged.zip, imports it (POST /suite-api/api/policies/import?forceImport=true) and assigns the groups.',
                  'Or import import/policy-merged.zip yourself: Infrastructure Operations → Configurations → Policies → Import.',
                ],
                verify: [
                  'the element names for symptoms (Symptoms/Symptom), metrics (AttributeKinds/AttributeKind), capacity (CapacityAnalysis), Workload Automation (WorkloadAutomation) and custom profiles (CustomProfiles) are not in a published schema; the merge stops if the export has never contained them. Set one such value in the interface once, export, and rename them to what the export uses.',
                  ...(create ? ['creating the policy uses POST /suite-api/api/policies with parentPolicyId; if your release refuses it, create the policy in the interface and run again.'] : []),
                ],
              },
            ],
            sources: FORMAT_SOURCES,
          }),
        },
        notes: [
          'A super metric is only calculated where a policy enables it: add a metrics row with the key Super Metric|sm_<id> and state on, for the object kind it is assigned to.',
          'A policy inherits from its parent. Everything not merged here keeps whatever the policy or its parent says now.',
          'Policy priority decides which policy wins for an object in two groups. There is no documented API call to reorder policies, so the script prints the one step to do in the interface.',
          'The policy toggle blueprint does the alerts-only version of this with the same merge.',
        ],
        findings,
      };
    },
  }),
];
