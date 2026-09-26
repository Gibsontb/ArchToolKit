/**
 * VCF Operations symptoms, alert definitions and policy changes, as data.
 *
 * The alert blueprint used to know one kind of symptom (a static metric
 * threshold) and one symptom set (on the object itself). VCF Operations has
 * more: dynamic thresholds, property tests on strings and numbers, message
 * events, faults, metric events and log-based symptoms; symptom sets on the
 * object, its children, parents, descendants or ancestors, each with a
 * population (all, any, at least n, at least n %). This module holds that
 * model once, so the alert, the standalone symptom and the alert group
 * blueprints write the same shapes.
 *
 * It also writes policy-apply.sh: the export, merge, import and read-back
 * that turns "enable it in a policy" from a manual step into an applied one.
 *
 * Shapes follow the suite API (/suite-api/api/symptomdefinitions,
 * /alertdefinitions) and the alert content XML Alerts → Import takes. Where a
 * field is not confirmed for 9.1 the kind says so in `verify`.
 */

import { xe } from '../vcfops-import.ts';
import { authHeader, authPreamble } from '../apply.ts';

export type Severity = 'INFO' | 'WARNING' | 'IMMEDIATE' | 'CRITICAL';

export type SymptomKind = 'metric' | 'dynamic' | 'property' | 'property-numeric' | 'message' | 'fault' | 'metric-event' | 'log';

export interface SymptomKindInfo {
  readonly value: SymptomKind;
  readonly label: string;
  /** Operators the API takes for this kind, first is the default. */
  readonly operators: readonly { readonly value: string; readonly label: string }[];
  /** What the key column holds for this kind. */
  readonly keyIs: string;
  /** Whether a value is compared, and what it is. */
  readonly valueIs?: string;
  /** Anything about the shape not confirmed for 9.1. */
  readonly verify?: string;
}

const NUMERIC_OPS = [
  { value: 'GT', label: 'is above' },
  { value: 'GT_EQ', label: 'is at or above' },
  { value: 'LT', label: 'is below' },
  { value: 'LT_EQ', label: 'is at or below' },
  { value: 'EQ', label: 'equals' },
  { value: 'NOT_EQ', label: 'does not equal' },
] as const;

const STRING_OPS = [
  { value: 'EQ', label: 'equals' },
  { value: 'NOT_EQ', label: 'does not equal' },
  { value: 'CONTAINS', label: 'contains' },
  { value: 'NOT_CONTAINS', label: 'does not contain' },
  { value: 'STARTS_WITH', label: 'starts with' },
  { value: 'ENDS_WITH', label: 'ends with' },
  { value: 'REGEX', label: 'matches regex' },
  { value: 'NOT_REGEX', label: 'does not match regex' },
] as const;

export const SYMPTOM_KINDS: readonly SymptomKindInfo[] = [
  { value: 'metric', label: 'Metric — static threshold', operators: NUMERIC_OPS, keyIs: 'metric key', valueIs: 'threshold' },
  {
    value: 'dynamic',
    label: 'Metric — dynamic threshold (DT)',
    operators: [
      { value: 'DT_ABOVE', label: 'above its dynamic threshold' },
      { value: 'DT_BELOW', label: 'below its dynamic threshold' },
      { value: 'DT_ABNORMAL', label: 'outside its dynamic threshold' },
    ],
    keyIs: 'metric key',
    verify: 'the CONDITION_DT operator names (DT_ABOVE, DT_BELOW, DT_ABNORMAL) and the XML thresholdType="dynamic" operator words',
  },
  { value: 'property', label: 'Property — text', operators: STRING_OPS, keyIs: 'property key', valueIs: 'text', verify: 'the string operator names beyond EQ / NOT_EQ / CONTAINS, and the XML operator words' },
  { value: 'property-numeric', label: 'Property — number', operators: NUMERIC_OPS, keyIs: 'property key', valueIs: 'number' },
  {
    value: 'message',
    label: 'Message event',
    operators: [
      { value: 'CONTAINS', label: 'message contains' },
      { value: 'NOT_CONTAINS', label: 'message does not contain' },
      { value: 'EQ', label: 'message equals' },
      { value: 'REGEX', label: 'message matches regex' },
    ],
    keyIs: 'event type (MESSAGE_EVENT, or the adapter’s own)',
    valueIs: 'message text',
    verify: 'the CONDITION_MESSAGE_EVENT fields (eventType, eventSubType, message) for the adapter that raises the event',
  },
  { value: 'fault', label: 'Fault', operators: [{ value: 'EQ', label: 'is raised' }], keyIs: 'fault key (e.g. fault|hardware|...)', verify: 'the CONDITION_FAULT fields (faultKey, faultEvents) — copy a fault key from an existing fault symptom' },
  { value: 'metric-event', label: 'Metric event', operators: NUMERIC_OPS, keyIs: 'metric key the adapter raises the event on', valueIs: 'threshold', verify: 'the metric event condition shape: eventType METRIC_EVENT under CONDITION_MESSAGE_EVENT' },
  {
    value: 'log',
    label: 'Log — saved query',
    operators: [
      { value: 'GT', label: 'matches more than' },
      { value: 'GT_EQ', label: 'matches at least' },
    ],
    keyIs: 'saved log query name',
    valueIs: 'events in the query window',
    verify: 'the log-based symptom condition: 9.1 creates it from a saved query in Log Explorer (“Create alert from query”); the REST shape here is not documented. "Log alert from a saved query" (vcflog91_alert_query) is the documented route',
  },
];

export function kindInfo(kind: string): SymptomKindInfo {
  return SYMPTOM_KINDS.find((entry) => entry.value === kind) ?? SYMPTOM_KINDS[0]!;
}

/** The object types people write alerts, symptoms and super metrics against. */
export const OBJECT_TYPES: readonly { readonly value: string; readonly label: string; readonly group: string }[] = [
  { value: 'VMWARE:VirtualMachine', label: 'Virtual machine', group: 'vSphere' },
  { value: 'VMWARE:HostSystem', label: 'ESX host', group: 'vSphere' },
  { value: 'VMWARE:ClusterComputeResource', label: 'Cluster', group: 'vSphere' },
  { value: 'VMWARE:Datastore', label: 'Datastore', group: 'vSphere' },
  { value: 'VMWARE:StoragePod', label: 'Datastore cluster', group: 'vSphere' },
  { value: 'VMWARE:Datacenter', label: 'Datacenter', group: 'vSphere' },
  { value: 'VMWARE:VMwareAdapter Instance', label: 'vCenter', group: 'vSphere' },
  { value: 'VMWARE:VmwareDistributedVirtualSwitch', label: 'Distributed switch', group: 'vSphere' },
  { value: 'VMWARE:DistributedVirtualPortgroup', label: 'Distributed port group', group: 'vSphere' },
  { value: 'VirtualAndPhysicalSANAdapter:VirtualSANDCCluster', label: 'vSAN cluster', group: 'vSAN' },
  { value: 'VirtualAndPhysicalSANAdapter:CacheDisk', label: 'vSAN cache disk', group: 'vSAN' },
  { value: 'NSXTAdapter:TransportNode', label: 'NSX transport node', group: 'NSX' },
  { value: 'NSXTAdapter:LogicalRouter', label: 'NSX gateway', group: 'NSX' },
  { value: 'NSXTAdapter:ManagementCluster', label: 'NSX management cluster', group: 'NSX' },
  { value: 'VMWARE:Namespace', label: 'vSphere namespace', group: 'Kubernetes' },
  { value: 'KubernetesAdapter:KubernetesCluster', label: 'VKS cluster', group: 'Kubernetes' },
];

export function splitKind(value: string, fallback = 'VMWARE:HostSystem'): { adapterKind: string; resourceKind: string } {
  const text = value.trim() || fallback;
  const at = text.indexOf(':');
  if (at < 0) return { adapterKind: 'VMWARE', resourceKind: text };
  return { adapterKind: text.slice(0, at).trim() || 'VMWARE', resourceKind: text.slice(at + 1).trim() || 'HostSystem' };
}

export function kindLabel(adapterKind: string, resourceKind: string): string {
  return OBJECT_TYPES.find((entry) => entry.value === `${adapterKind}:${resourceKind}`)?.label ?? resourceKind;
}

export interface SymptomSpec {
  /** The id the XML import uses, and the placeholder the apply script swaps for the API's id. */
  readonly id: string;
  readonly placeholder: string;
  readonly kind: SymptomKind;
  readonly name: string;
  readonly adapterKind: string;
  readonly resourceKind: string;
  readonly severity: Severity;
  readonly key: string;
  readonly operator: string;
  readonly value: string;
  readonly wait: number;
  readonly cancel: number;
}

const SEVERITIES: readonly Severity[] = ['INFO', 'WARNING', 'IMMEDIATE', 'CRITICAL'];

export function severityOf(text: string, fallback: Severity = 'WARNING'): Severity {
  const upper = text.trim().toUpperCase();
  return (SEVERITIES as readonly string[]).includes(upper) ? (upper as Severity) : fallback;
}

/** The condition, as POST /suite-api/api/symptomdefinitions takes it. */
export function conditionJson(spec: SymptomSpec): Record<string, unknown> {
  const numeric = Number(spec.value);
  switch (spec.kind) {
    case 'dynamic':
      return { type: 'CONDITION_DT', key: spec.key, operator: spec.operator, instanced: false };
    case 'property':
      return { type: 'CONDITION_PROPERTY_STRING', key: spec.key, operator: spec.operator, stringValue: spec.value };
    case 'property-numeric':
      return { type: 'CONDITION_PROPERTY_NUMERIC', key: spec.key, operator: spec.operator, value: Number.isFinite(numeric) ? numeric : 0 };
    case 'message':
      return { type: 'CONDITION_MESSAGE_EVENT', eventType: spec.key || 'MESSAGE_EVENT', operator: spec.operator, message: spec.value };
    case 'fault':
      return { type: 'CONDITION_FAULT', faultKey: spec.key };
    case 'metric-event':
      return { type: 'CONDITION_MESSAGE_EVENT', eventType: 'METRIC_EVENT', key: spec.key, operator: spec.operator, value: Number.isFinite(numeric) ? numeric : 0 };
    case 'log':
      return { type: 'CONDITION_MESSAGE_EVENT', eventType: 'LOG_EVENT', savedQuery: spec.key, operator: spec.operator, value: Number.isFinite(numeric) ? numeric : 0 };
    default:
      return { type: 'CONDITION_HT', key: spec.key, operator: spec.operator, value: Number.isFinite(numeric) ? numeric : 0, valueType: 'NUMERIC', instanced: false, thresholdType: 'STATIC' };
  }
}

export function symptomJson(spec: SymptomSpec): Record<string, unknown> {
  return {
    name: spec.name,
    adapterKindKey: spec.adapterKind,
    resourceKindKey: spec.resourceKind,
    waitCycles: spec.wait,
    cancelCycles: spec.cancel,
    state: { severity: spec.severity, condition: conditionJson(spec) },
  };
}

const XML_NUMERIC: Readonly<Record<string, string>> = { GT: '>', GT_EQ: '>=', LT: '<', LT_EQ: '<=', EQ: '=', NOT_EQ: '!=' };
const XML_STRING: Readonly<Record<string, string>> = {
  EQ: '=',
  NOT_EQ: '!=',
  CONTAINS: 'contains',
  NOT_CONTAINS: 'not contains',
  STARTS_WITH: 'starts with',
  ENDS_WITH: 'ends with',
  REGEX: 'regex',
  NOT_REGEX: 'not regex',
};
const XML_DT: Readonly<Record<string, string>> = { DT_ABOVE: 'above', DT_BELOW: 'below', DT_ABNORMAL: 'abnormal' };

function xmlNumber(value: string): string {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return '0.0';
  return Number.isInteger(numeric) ? numeric.toFixed(1) : String(numeric);
}

function conditionXml(spec: SymptomSpec): string {
  switch (spec.kind) {
    case 'dynamic':
      return `<Condition instanced="false" key="${xe(spec.key)}" operator="${XML_DT[spec.operator] ?? 'above'}" thresholdType="dynamic" type="metric"/>`;
    case 'property':
      return `<Condition key="${xe(spec.key)}" operator="${xe(XML_STRING[spec.operator] ?? '=')}" type="property" value="${xe(spec.value)}" valueType="string"/>`;
    case 'property-numeric':
      return `<Condition key="${xe(spec.key)}" operator="${xe(XML_NUMERIC[spec.operator] ?? '>')}" type="property" value="${xmlNumber(spec.value)}" valueType="numeric"/>`;
    case 'message':
      return `<Condition eventType="${xe(spec.key || 'MESSAGE_EVENT')}" operator="${xe(XML_STRING[spec.operator] ?? 'contains')}" type="msg_event" value="${xe(spec.value)}"/>`;
    case 'fault':
      return `<Condition faultKey="${xe(spec.key)}" type="fault"/>`;
    case 'metric-event':
      return `<Condition eventType="METRIC_EVENT" key="${xe(spec.key)}" operator="${xe(XML_NUMERIC[spec.operator] ?? '>')}" type="msg_event" value="${xmlNumber(spec.value)}"/>`;
    case 'log':
      return `<Condition eventType="LOG_EVENT" key="${xe(spec.key)}" operator="${xe(XML_NUMERIC[spec.operator] ?? '>')}" type="msg_event" value="${xmlNumber(spec.value)}"/>`;
    default:
      return `<Condition instanced="false" key="${xe(spec.key)}" operator="${xe(XML_NUMERIC[spec.operator] ?? '>')}" thresholdType="static" type="metric" value="${xmlNumber(spec.value)}" valueType="numeric"/>`;
  }
}

function symptomXmlLines(spec: SymptomSpec): string[] {
  return [
    `        <SymptomDefinition adapterKind="${xe(spec.adapterKind)}" cancelCycle="${spec.cancel}" id="${xe(spec.id)}" name="${xe(spec.name)}" resourceKind="${xe(spec.resourceKind)}" waitCycle="${spec.wait}">`,
    `            <State severity="${spec.severity.toLowerCase()}">`,
    `                ${conditionXml(spec)}`,
    '            </State>',
    '        </SymptomDefinition>',
  ];
}

export type Relation = 'SELF' | 'CHILD' | 'PARENT' | 'DESCENDANT' | 'ANCESTOR';
export type Population = 'ALL' | 'ANY' | 'COUNT' | 'PERCENT';

export interface SymptomSetSpec {
  readonly relation: Relation;
  /** For a set on related objects: which kind of related object. */
  readonly adapterKind: string;
  readonly resourceKind: string;
  readonly population: Population;
  /** For COUNT and PERCENT: at least this many, or this percentage. */
  readonly n: number;
  /** How the symptoms inside the set combine. */
  readonly combine: 'AND' | 'OR';
  readonly symptoms: readonly SymptomSpec[];
}

export type Impact = 'HEALTH' | 'RISK' | 'EFFICIENCY';

export interface AlertSpec {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly adapterKind: string;
  readonly resourceKind: string;
  readonly type: number;
  readonly subType: number;
  /** AUTO takes the criticality of the worst symptom that holds. */
  readonly criticality: 'AUTO' | Severity;
  readonly impact: Impact;
  /** ALL: every set must hold; ANY: one is enough. */
  readonly setsOperator: 'AND' | 'OR';
  readonly sets: readonly SymptomSetSpec[];
  /** Recommendation XML keys and REST placeholders, in priority order. */
  readonly recommendations: readonly { readonly key: string; readonly placeholder: string; readonly description: string }[];
}

function setJson(set: SymptomSetSpec): Record<string, unknown> {
  return {
    type: 'SYMPTOM_SET',
    relation: set.relation,
    ...(set.relation !== 'SELF' ? { adapterKindKey: set.adapterKind, resourceKindKey: set.resourceKind } : {}),
    aggregation: set.population,
    ...(set.population === 'COUNT' || set.population === 'PERCENT' ? { value: set.n } : {}),
    symptomSetOperator: set.combine,
    symptomDefinitionIds: set.symptoms.map((symptom) => symptom.placeholder),
  };
}

/** The alert, as POST /suite-api/api/alertdefinitions takes it, with placeholders for the ids. */
export function alertJson(spec: AlertSpec): Record<string, unknown> {
  const sets = spec.sets.filter((set) => set.symptoms.length > 0);
  const base = sets.length === 1 ? setJson(sets[0]!) : { type: 'SYMPTOM_SET_COMPOSITE', operator: spec.setsOperator, 'symptom-sets': sets.map(setJson) };
  return {
    name: spec.name,
    description: spec.description,
    adapterKindKey: spec.adapterKind,
    resourceKindKey: spec.resourceKind,
    waitCycles: 1,
    cancelCycles: 1,
    type: spec.type,
    subType: spec.subType,
    states: [
      {
        severity: spec.criticality,
        'base-symptom-set': base,
        impact: { impactType: 'BADGE', detail: spec.impact },
        ...(spec.recommendations.length > 0 ? { recommendationPriorityMap: Object.fromEntries(spec.recommendations.map((rec, index) => [rec.placeholder, index + 1])) } : {}),
      },
    ],
  };
}

function alertXmlLines(spec: AlertSpec): string[] {
  const sets = spec.sets.filter((set) => set.symptoms.length > 0);
  const setLines = sets.flatMap((set) => {
    const related = set.relation !== 'SELF' ? ` adapterKind="${xe(set.adapterKind)}"` : '';
    const population = set.relation !== 'SELF' ? ` aggregation="${set.population.toLowerCase()}"${set.population === 'COUNT' || set.population === 'PERCENT' ? ` value="${set.n}"` : ''}` : '';
    const kind = set.relation !== 'SELF' ? ` resourceKind="${xe(set.resourceKind)}"` : '';
    return [
      `                    <SymptomSet${related}${population} applyOn="${set.relation.toLowerCase()}" operator="${set.combine.toLowerCase()}"${kind}>`,
      ...set.symptoms.map((symptom) => `                        <Symptom ref="${xe(symptom.id)}"/>`),
      '                    </SymptomSet>',
    ];
  });
  return [
    `        <AlertDefinition adapterKind="${xe(spec.adapterKind)}" description="${xe(spec.description)}" id="${xe(spec.id)}" name="${xe(spec.name)}" resourceKind="${xe(spec.resourceKind)}" subType="${spec.subType}" type="${spec.type}">`,
    `            <State severity="${spec.criticality === 'AUTO' ? 'automatic' : spec.criticality.toLowerCase()}">`,
    `                <SymptomSets operator="${spec.setsOperator.toLowerCase()}">`,
    ...setLines,
    '                </SymptomSets>',
    `                <Impact key="${spec.impact.toLowerCase()}" type="badge"/>`,
    ...(spec.recommendations.length > 0
      ? ['                <Recommendations>', ...spec.recommendations.map((rec, index) => `                    <Recommendation priority="${index + 1}" ref="${xe(rec.key)}"/>`), '                </Recommendations>']
      : []),
    '            </State>',
    '        </AlertDefinition>',
  ];
}

/**
 * `<alertContent>` for alerts built from this model. `only` writes one section,
 * as the content-management package splits them.
 */
export function alertModelXml(alerts: readonly AlertSpec[], symptoms: readonly SymptomSpec[], only?: 'alerts' | 'symptoms' | 'recommendations'): string {
  const recommendations = alerts.flatMap((alert) => alert.recommendations);
  const lines = ['<?xml version="1.0" encoding="UTF-8"?>', '<alertContent>'];
  if ((!only || only === 'alerts') && alerts.length > 0) lines.push('    <AlertDefinitions>', ...alerts.flatMap(alertXmlLines), '    </AlertDefinitions>');
  if ((!only || only === 'symptoms') && symptoms.length > 0) lines.push('    <SymptomDefinitions>', ...symptoms.flatMap(symptomXmlLines), '    </SymptomDefinitions>');
  if ((!only || only === 'recommendations') && recommendations.length > 0) {
    lines.push('    <Recommendations>', ...recommendations.flatMap((rec) => [`        <Recommendation key="${xe(rec.key)}">`, `            <Description>${xe(rec.description)}</Description>`, '        </Recommendation>']), '    </Recommendations>');
  }
  lines.push('</alertContent>', '');
  return lines.join('\n');
}

/** Split one " | " row. Metric keys hold "|" themselves, so columns are " | " with spaces. */
export function cells(line: string): string[] {
  return line.split(/\s+\|\s+/).map((part) => part.trim());
}

/** The non-empty, non-comment lines of a textarea. */
export function rows(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
}

// ---------------------------------------------------------------------------
// Policy changes, applied: export → merge → import → read back
// ---------------------------------------------------------------------------

/**
 * One change to a policy: an item inside a block of PackageSettings, found by
 * adapter kind, resource kind and (where it has one) id, with the attributes
 * to set on it. Alerts are block "Alerts", item "Alert".
 */
export interface PolicyChange {
  readonly label: string;
  readonly block: string;
  readonly item: string;
  readonly adapterKind: string;
  readonly resourceKind: string;
  readonly id?: string;
  readonly set: Readonly<Record<string, string>>;
}

export interface PolicyChanges {
  /** The policies to change, by name. "Default Policy" also matches the policy flagged as default. */
  readonly policies: readonly string[];
  /** Create a missing policy under this parent, rather than stopping. */
  readonly create?: { readonly parent: string; readonly description: string };
  readonly changes: readonly PolicyChange[];
  /** Custom groups the policy is assigned to, by name. */
  readonly groups?: readonly string[];
  readonly priority?: number;
}

export function policyChangesJson(changes: PolicyChanges): string {
  return `${JSON.stringify(changes, null, 2)}\n`;
}

const PY_COMMON = [
  'import json, re, sys, zipfile, xml.etree.ElementTree as ET',
  'def load(src):',
  '    with zipfile.ZipFile(src) as z:',
  '        names = z.namelist()',
  '        xmls = [n for n in names if n.lower().endswith(".xml")]',
  '        if len(xmls) != 1:',
  '            sys.exit("expected one XML file in the policy export, found %r" % xmls)',
  '        raw = z.read(xmls[0])',
  '        others = {n: z.read(n) for n in names if n != xmls[0]}',
  '    for prefix, uri in re.findall(r\'xmlns(?::([A-Za-z_][\\w.-]*))?="([^"]+)"\', raw.decode("utf-8")):',
  '        ET.register_namespace(prefix or "", uri)',
  '    root = ET.fromstring(raw)',
  '    policies = root.findall(".//{*}Policy")',
  '    if len(policies) != 1:',
  '        sys.exit("expected exactly one <Policy> in the export, found %d" % len(policies))',
  '    return xmls[0], others, root, policies[0]',
  'def find(parent, tag, test):',
  '    for candidate in parent.findall("{*}" + tag):',
  '        if test(candidate):',
  '            return candidate',
  '    return None',
  'def child(parent, tag, attrs):',
  '    ns = parent.tag[: parent.tag.index("}") + 1] if parent.tag.startswith("{") else ""',
  '    return ET.SubElement(parent, ns + tag, attrs)',
  'def locate(package, c, create):',
  '    block = find(package, c["block"], lambda e: e.get("adapterKind") == c["adapterKind"] and e.get("resourceKind") == c["resourceKind"])',
  '    if block is None:',
  '        if not create:',
  '            return None',
  '        block = child(package, c["block"], {"adapterKind": c["adapterKind"], "resourceKind": c["resourceKind"]})',
  '    item = find(block, c["item"], lambda e: ("id" not in c) or e.get("id") == c["id"])',
  '    if item is None and create:',
  '        item = child(block, c["item"], {"id": c["id"]} if "id" in c else {})',
  '    return item',
];

const PY_MERGE = [
  ...PY_COMMON,
  'src, changes_file, out = sys.argv[1:4]',
  'spec = json.load(open(changes_file))',
  'name, others, root, policy = load(src)',
  'package = policy.find("{*}PackageSettings")',
  'if package is None:',
  '    package = child(policy, "PackageSettings", {})',
  'changed = 0',
  'for c in spec.get("changes", []):',
  '    if "id" in c and (not c["id"] or "REQUIRED" in c["id"] or c["id"].startswith("__")):',
  '        sys.exit("%s has no id yet" % c["label"])',
  '    item = locate(package, c, True)',
  '    before = dict(item.attrib)',
  '    for key, value in c["set"].items():',
  '        item.set(key, str(value))',
  '    if before != dict(item.attrib):',
  '        changed += 1',
  '        print("  %s: %s -> %s" % (c["label"], before or "(inherited)", dict(item.attrib)))',
  'if spec.get("priority") is not None:',
  '    if "priority" in policy.attrib:',
  '        policy.set("priority", str(spec["priority"]))',
  '    else:',
  '        print("  priority: the export has no priority attribute; set it under Configure > Policies > Reorder (VERIFY)")',
  'with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:',
  '    z.writestr(name, ET.tostring(root, encoding="utf-8", xml_declaration=True))',
  '    for n, b in others.items():',
  '        z.writestr(n, b)',
  'print("%d setting(s) changed" % changed)',
];

const PY_VERIFY = [
  ...PY_COMMON,
  'src, changes_file = sys.argv[1:3]',
  'spec = json.load(open(changes_file))',
  'name, others, root, policy = load(src)',
  'package = policy.find("{*}PackageSettings")',
  'missing = []',
  'for c in spec.get("changes", []):',
  '    item = locate(package, c, False) if package is not None else None',
  '    if item is None or any(item.get(k) != str(v) for k, v in c["set"].items()):',
  '        missing.append(c["label"])',
  'for label in missing:',
  '    print("  NOT APPLIED: %s" % label)',
  'sys.exit(1 if missing else 0)',
];

/**
 * policy-apply.sh CHANGES.json [--dry-run]: for each policy named, find it (or
 * create it under its parent), export it (kept as the undo), merge the
 * changes, import the merged zip, export it again and check every change is
 * there, then assign it to its groups. Exit 4 means applied in part: what is
 * missing is printed with the manual step.
 */
export function policyApplyScript(): string {
  const auth = authHeader('vcf-operations');
  const authVar = auth.slice(3, -1);
  return [
    '#!/usr/bin/env bash',
    '# Apply policy changes: find (or create) each policy, export it, merge the',
    '# changes, import it, and read it back to check every change took.',
    '#',
    '# Usage: ./policy-apply.sh CHANGES.json [--dry-run]',
    '#',
    '# A policy XML holds all of a policy\'s overrides, so a fragment is never',
    '# imported on its own: the export of the policy as it is now is merged and',
    '# re-imported, and kept beside this script as policy-before-<id>-<time>.zip.',
    '# Re-importing that zip (POST /suite-api/api/policies/import?forceImport=true,',
    '# multipart field policy) is the undo.',
    '#',
    '# Exit 0: applied and read back. 2: could not run. 4: imported, but a change',
    '# did not read back or a group could not be assigned — the manual step is printed.',
    'set -euo pipefail',
    ...authPreamble('vcf-operations'),
    'for tool in curl jq python3; do command -v "$tool" >/dev/null || { echo "$tool is required" >&2; exit 2; }; done',
    'CHANGES="${1:?usage: policy-apply.sh CHANGES.json [--dry-run]}"',
    '[[ -r "$CHANGES" ]] || { echo "Cannot read $CHANGES" >&2; exit 2; }',
    'EXECUTE=1',
    '[[ "${2:-}" == "--dry-run" ]] && EXECUTE=0',
    'HERE=$(cd "$(dirname "$0")" && pwd)',
    'WORK=$(umask 077; mktemp -d "${TMPDIR:-/tmp}/work.XXXXXX")',
    `trap 'rm -rf "$WORK" "\${${authVar}:-}"' EXIT`,
    '',
    `get() { curl -sS -f "https://\${VCFOPS_HOST}$1" -H "${auth}" -H "Accept: application/json"; }`,
    `send() { curl -sS -f -X "$1" "https://\${VCFOPS_HOST}$2" -H "${auth}" -H "Accept: application/json" -H "Content-Type: application/json" --data-binary @"$3"; }`,
    `export_policy() { curl -sS -f "https://\${VCFOPS_HOST}/suite-api/api/policies/export?id=$1" -H "${auth}" -H "Accept: application/zip" -o "$2"; }`,
    '',
    "cat > \"$WORK/merge.py\" <<'PY'",
    ...PY_MERGE,
    'PY',
    "cat > \"$WORK/verify.py\" <<'PY'",
    ...PY_VERIFY,
    'PY',
    '',
    'load_policies() { get /suite-api/api/policies > "$WORK/policies.json" || { echo "Cannot list policies." >&2; exit 2; }; }',
    '# The id of a policy by name. "Default Policy" also finds the policy flagged as the default,',
    '# whatever it is called on this instance. VERIFY: policySummaries[].{id,name,defaultPolicy}.',
    "policy_id() { jq -r --arg n \"$1\" '[(.policySummaries // .policies // [])[] | select(.name == $n or (($n == \"Default Policy\") and (.defaultPolicy == true)))][0].id // empty' \"$WORK/policies.json\"; }",
    'load_policies',
    '',
    'mapfile -t NAMES < <(jq -r \'.policies[]\' "$CHANGES")',
    '(( ${#NAMES[@]} > 0 )) || { echo "$CHANGES names no policy." >&2; exit 2; }',
    'RC=0',
    'for NAME in "${NAMES[@]}"; do',
    '  echo "== $NAME"',
    '  ID=$(policy_id "$NAME")',
    '  if [[ -z "$ID" ]]; then',
    '    if jq -e \'.create\' "$CHANGES" >/dev/null; then',
    '      PARENT=$(jq -r \'.create.parent\' "$CHANGES")',
    '      PARENT_ID=$(policy_id "$PARENT")',
    '      [[ -n "$PARENT_ID" ]] || { echo "The parent policy \\"$PARENT\\" does not exist." >&2; exit 2; }',
    '      if (( ! EXECUTE )); then echo "DRY RUN: would create \\"$NAME\\" under \\"$PARENT\\", then merge, import and assign it."; continue; fi',
    '      # VERIFY: POST /suite-api/api/policies and the parent field name on your release.',
    '      jq -n --arg n "$NAME" --arg p "$PARENT_ID" --slurpfile c "$CHANGES" \'{name: $n, description: ($c[0].create.description // ""), parentPolicyId: $p}\' > "$WORK/create.json"',
    '      if ! send POST /suite-api/api/policies "$WORK/create.json" > "$WORK/created.json"; then',
    '        echo "Could not create \\"$NAME\\" through the API. Create it once: Configure > Policies > Add, inheriting from \\"$PARENT\\"; then run this again to apply the rest." >&2',
    '        exit 4',
    '      fi',
    '      load_policies',
    '      ID=$(policy_id "$NAME")',
    '      [[ -n "$ID" ]] || { echo "Created \\"$NAME\\" but cannot find it by name." >&2; exit 2; }',
    '      echo "Created \\"$NAME\\" ($ID) under \\"$PARENT\\"."',
    '    else',
    '      echo "No policy named \\"$NAME\\". Policies here:" >&2',
    '      jq -r \'(.policySummaries // .policies // [])[].name | "  " + .\' "$WORK/policies.json" >&2',
    '      exit 2',
    '    fi',
    '  fi',
    '  BEFORE="$HERE/policy-before-${ID}-$(date +%Y%m%d-%H%M%S).zip"',
    '  export_policy "$ID" "$BEFORE" || { echo "Cannot export \\"$NAME\\"." >&2; exit 2; }',
    '  echo "Exported \\"$NAME\\" as it is now: $BEFORE (the undo)"',
    '  python3 "$WORK/merge.py" "$BEFORE" "$CHANGES" "$WORK/merged.zip" || exit 2',
    '  if (( ! EXECUTE )); then',
    '    echo "DRY RUN: would import the merged policy and assign it to its groups."',
    '    continue',
    '  fi',
    `  curl -sS -f -X POST "https://\${VCFOPS_HOST}/suite-api/api/policies/import?forceImport=true" -H "${auth}" -H "Accept: application/json" -F "policy=@$WORK/merged.zip;type=application/zip" >/dev/null \\`,
    '    || { echo "The import of \\"$NAME\\" failed; nothing changed. Undo is not needed." >&2; exit 2; }',
    '  # Read it back: a setting a release does not know is dropped on import without a word.',
    '  export_policy "$ID" "$WORK/after.zip" || { echo "Imported, but cannot export \\"$NAME\\" to check it." >&2; RC=4; continue; }',
    '  if python3 "$WORK/verify.py" "$WORK/after.zip" "$CHANGES"; then',
    '    echo "Every change reads back in \\"$NAME\\"."',
    '  else',
    '    echo "Set the settings above by hand: Configure > Policies > \\"$NAME\\" > Edit. Undo: re-import $BEFORE." >&2',
    '    RC=4',
    '  fi',
    '  # Groups: VERIFY PUT /suite-api/api/policies/apply {id, groups} on your release.',
    '  mapfile -t GROUP_NAMES < <(jq -r \'(.groups // [])[]\' "$CHANGES")',
    '  if (( ${#GROUP_NAMES[@]} > 0 )); then',
    '    : > "$WORK/gids.txt"',
    '    for G in "${GROUP_NAMES[@]}"; do',
    '      get "/suite-api/api/resources/groups?name=$(jq -rn --arg g "$G" \'$g | @uri\')" > "$WORK/g.json" || { echo "Cannot look up the group \\"$G\\"." >&2; exit 2; }',
    '      GID=$(jq -r --arg g "$G" \'[(.groups // [])[] | select(.resourceKey.name == $g)][0].id // empty\' "$WORK/g.json")',
    '      [[ -n "$GID" ]] || { echo "No custom group named \\"$G\\": create it first." >&2; RC=4; continue; }',
    '      echo "$GID" >> "$WORK/gids.txt"',
    '    done',
    '    jq -Rn --arg id "$ID" \'{id: $id, groups: [inputs | select(. != "")]}\' < "$WORK/gids.txt" > "$WORK/apply.json"',
    '    if send PUT /suite-api/api/policies/apply "$WORK/apply.json" >/dev/null; then',
    '      echo "Assigned \\"$NAME\\" to: ${GROUP_NAMES[*]}"',
    '    else',
    '      echo "Could not assign groups through the API. Configure > Policies > \\"$NAME\\" > Edit > Custom Groups: ${GROUP_NAMES[*]}" >&2',
    '      RC=4',
    '    fi',
    '  fi',
    'done',
    '(( EXECUTE )) || echo "Dry run: nothing was changed. Run it without --dry-run to apply."',
    'exit $RC',
    '',
  ].join('\n');
}
