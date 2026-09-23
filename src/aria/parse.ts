/**
 * Reading whatever Aria Operations gave you.
 *
 * There is no single export. People arrive with some mixture of:
 *
 *  - a content package (`.zip`) taken from the appliance, which holds
 *    `alertdefs.xml`, `symptomdefs.xml`, `policies.xml`,
 *    `recommendationdefs.xml`, `customgroups.json`, `supermetrics.json`,
 *    `notificationrules.json`, `views.zip`, `reports.zip`, a `dashboards/`
 *    folder of one zip per dashboard, and `reportschedules/`;
 *  - separate JSON inventories pulled from the suite API by a script, one file
 *    per kind, usually written by PowerShell and therefore usually with a
 *    byte-order mark on the front;
 *  - one of those two, half of it, in any order.
 *
 * So nothing here asks what the file is. Each one is sniffed by its shape, read
 * for whatever it turns out to hold, and merged into the content already read.
 * Dropping the package and then a newer alert-definitions inventory over the
 * top of it does the sensible thing.
 *
 * None of it leaves the machine. The files are read where they are dropped.
 */

import { openZip, looksLikeZip, stripBom, ZipError, type ZipArchive } from '../core/zip.ts';
import {
  EMPTY_CONTENT,
  highestSeverity,
  merge,
  severityOf,
  type AlertDefinition,
  type AlertState,
  type AriaContent,
  type AriaSource,
  type CustomGroup,
  type Dashboard,
  type DashboardWidget,
  type GroupRule,
  type NotificationRule,
  type NotificationTemplate,
  type PolicySummary,
  type Recommendation,
  type ReportDefinition,
  type SuperMetric,
  type SymptomDefinition,
  type ViewDefinition,
} from './aria.ts';

export class AriaError extends Error {}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

type Json = unknown;

function isRecord(value: Json): value is Record<string, Json> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: Json): string {
  return typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value);
}

function num(value: Json): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function arr(value: Json): Json[] {
  return Array.isArray(value) ? value : [];
}

function strings(value: Json): string[] {
  return arr(value).map(str).filter(Boolean);
}

function parseJson(text: string, what: string): Json {
  try {
    return JSON.parse(stripBom(text)) as Json;
  } catch (error) {
    throw new AriaError(`${what} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function source(name: string, kind: string, records: number): AriaSource {
  return { name, kind, records };
}

// ---------------------------------------------------------------------------
// XML
//
// Only attributes and nesting are needed, and the files are small enough to
// hold whole, so a scan over start tags is both correct and quick. It is not a
// general XML parser and does not pretend to be.
// ---------------------------------------------------------------------------

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

export function decodeEntities(text: string): string {
  if (!text.includes('&')) return text;
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (whole, code: string) => {
    if (code.startsWith('#x')) return String.fromCodePoint(parseInt(code.slice(2), 16));
    if (code.startsWith('#')) return String.fromCodePoint(parseInt(code.slice(1), 10));
    return ENTITIES[code] ?? whole;
  });
}

export interface XmlElement {
  readonly tag: string;
  readonly attrs: Readonly<Record<string, string>>;
  /** Everything between the start and matching end tag, or '' when self-closed. */
  readonly inner: string;
}

function readAttrs(head: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const match of head.matchAll(/([A-Za-z_:][\w.:-]*)\s*=\s*"([^"]*)"/g)) {
    const key = match[1];
    if (key) attrs[key] = decodeEntities(match[2] ?? '');
  }
  return attrs;
}

/** Every `<tag …>` element at any depth, with its attributes and inner text. */
export function elements(xml: string, tag: string): XmlElement[] {
  const found: XmlElement[] = [];
  const open = new RegExp(`<${tag}(\\s[^>]*?)?(/)?>`, 'g');
  for (const match of xml.matchAll(open)) {
    const head = match[1] ?? '';
    const attrs = readAttrs(head);
    const at = match.index ?? 0;
    if (match[2] === '/') {
      found.push({ tag, attrs, inner: '' });
      continue;
    }
    // Find the matching close, allowing for the same tag nested inside itself.
    let depth = 1;
    let cursor = at + match[0].length;
    const start = cursor;
    const scan = new RegExp(`<(/)?${tag}(\\s[^>]*?)?(/)?>`, 'g');
    scan.lastIndex = cursor;
    let end = -1;
    for (;;) {
      const next = scan.exec(xml);
      if (!next) break;
      if (next[3] === '/') continue;
      depth += next[1] ? -1 : 1;
      if (depth === 0) {
        end = next.index;
        break;
      }
      cursor = scan.lastIndex;
    }
    found.push({ tag, attrs, inner: end >= 0 ? xml.slice(start, end) : '' });
  }
  return found;
}

/** The text of the first `<tag>…</tag>` inside some XML. */
export function textOf(xml: string, tag: string): string | undefined {
  const match = new RegExp(`<${tag}(?:\\s[^>]*?)?>([\\s\\S]*?)</${tag}>`).exec(xml);
  return match ? decodeEntities(match[1] ?? '').trim() : undefined;
}

// ---------------------------------------------------------------------------
// The JSON inventories
// ---------------------------------------------------------------------------

function readAlert(record: Record<string, Json>): AlertDefinition {
  const states: AlertState[] = arr(record['states']).filter(isRecord).map((state) => {
    const base = isRecord(state['base-symptom-set']) ? state['base-symptom-set'] : {};
    const impact = isRecord(state['impact']) ? state['impact'] : {};
    return {
      severity: severityOf(str(state['severity'])),
      symptomIds: strings(base['symptomDefinitionIds']),
      operator: str(base['symptomSetOperator']) || 'OR',
      impact: str(impact['detail']) || str(impact['impactType']),
      // A map of recommendation id to priority, not a list — reading it as a
      // list quietly returns nothing, which reads as "no recommendations".
      recommendationIds: isRecord(state['recommendationPriorityMap'])
        ? Object.keys(state['recommendationPriorityMap']).sort(
            (a, b) => Number((state['recommendationPriorityMap'] as Record<string, Json>)[a] ?? 0) - Number((state['recommendationPriorityMap'] as Record<string, Json>)[b] ?? 0),
          )
        : [],
    };
  });

  return {
    id: str(record['id']),
    name: str(record['name']),
    description: str(record['description']) || undefined,
    adapterKind: str(record['adapterKindKey']),
    resourceKind: str(record['resourceKindKey']),
    waitCycles: num(record['waitCycles']),
    cancelCycles: num(record['cancelCycles']),
    states,
    severity: highestSeverity(states.map((state) => state.severity)),
  };
}

function readSymptom(record: Record<string, Json>): SymptomDefinition {
  const state = isRecord(record['state']) ? record['state'] : {};
  const condition = isRecord(state['condition']) ? state['condition'] : {};
  return {
    id: str(record['id']),
    name: str(record['name']),
    adapterKind: str(record['adapterKindKey']),
    resourceKind: str(record['resourceKindKey']),
    severity: severityOf(str(state['severity'])),
    waitCycles: num(record['waitCycles']),
    cancelCycles: num(record['cancelCycles']),
    key: str(condition['key']) || undefined,
    operator: str(condition['operator']) || undefined,
    value: str(condition['value']) || undefined,
    thresholdType: str(condition['thresholdType']) || undefined,
    conditionType: str(condition['type']) || undefined,
  };
}

function readGroup(record: Record<string, Json>): CustomGroup {
  const key = isRecord(record['resourceKey']) ? record['resourceKey'] : {};
  const membership = isRecord(record['membershipDefinition']) ? record['membershipDefinition'] : {};

  const rules: GroupRule[] = arr(membership['rules'])
    .filter(isRecord)
    .map((rule) => {
      const kind = isRecord(rule['resourceKindKey']) ? rule['resourceKindKey'] : {};
      const conditions: string[] = [];
      for (const property of arr(rule['propertyConditionRules']).filter(isRecord)) {
        conditions.push(`${str(property['key'])} ${str(property['compareOperator'])} ${str(property['stringValue']) || str(property['doubleValue'])}`.trim());
      }
      for (const stat of arr(rule['statConditionRules']).filter(isRecord)) {
        conditions.push(`${str(stat['key'])} ${str(stat['compareOperator'])} ${str(stat['doubleValue'])}`.trim());
      }
      for (const name of arr(rule['resourceNameConditionRules']).filter(isRecord)) {
        conditions.push(`name ${str(name['compareOperator'])} ${str(name['name'])}`.trim());
      }
      for (const tag of arr(rule['resourceTagConditionRules']).filter(isRecord)) {
        conditions.push(`tag ${str(tag['compareOperator'])} ${str(tag['category'])}:${str(tag['name'])}`.trim());
      }
      for (const related of arr(rule['relationshipConditionRules']).filter(isRecord)) {
        conditions.push(`related ${str(related['compareOperator'])} ${str(related['resourceName'])}`.trim());
      }
      return {
        resourceKind: str(kind['resourceKind']),
        adapterKind: str(kind['adapterKind']),
        conditions,
      };
    });

  return {
    id: str(record['id']),
    name: str(key['name']) || str(record['name']),
    groupKind: str(key['resourceKindKey']),
    policyId: str(record['policy']) || undefined,
    autoResolve: record['autoResolveMembership'] !== false,
    rules,
    explicitMembers: arr(membership['includedResources']).length,
    excludedMembers: arr(membership['excludedResources']).length,
  };
}

const SUPER_METRIC_REF = /sm_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi;

function readSuperMetric(id: string, record: Record<string, Json>): SuperMetric {
  const formula = decodeEntities(str(record['formula']));
  const dependsOn = [...new Set([...formula.matchAll(SUPER_METRIC_REF)].map((match) => (match[1] ?? '').toLowerCase()))];
  return {
    id: id || str(record['id']),
    name: str(record['name']),
    formula,
    description: str(record['description']) || undefined,
    modified: num(record['modificationTime']),
    dependsOn,
  };
}

function readRule(record: Record<string, Json>): NotificationRule {
  const properties: Record<string, string> = {};
  for (const property of arr(record['properties']).filter(isRecord)) {
    const name = str(property['name']);
    if (name) properties[name] = str(property['value']);
  }
  const alertFilter = isRecord(record['alertDefinitionIdFilters']) ? record['alertDefinitionIdFilters'] : {};
  const impactFilter = isRecord(record['alertImpactFilters']) ? record['alertImpactFilters'] : {};

  return {
    id: str(record['id']),
    name: str(record['name']),
    enabled: record['enabled'] !== false,
    templateId: str(record['templateId']) || undefined,
    ruleType: str(record['ruleType']) || 'ALERT',
    criticalities: strings(record['criticalities']),
    alertStatuses: strings(record['alertStatuses']),
    alertDefinitionIds: strings(alertFilter['values']),
    resourceKinds: arr(record['resourceKindFilters'])
      .filter(isRecord)
      .map((filter) => str(filter['resourceKind']))
      .filter(Boolean),
    impacts: strings(impactFilter['values']),
    properties,
  };
}

function readTemplate(record: Record<string, Json>): NotificationTemplate {
  return {
    id: str(record['templateId']) || str(record['id']),
    name: str(record['name']),
    pluginTypeId: str(record['pluginTypeId']),
    attachedRuleCount: num(record['attachedRuleCount']) ?? 0,
    editable: record['editable'] === true,
    templateType: str(record['templateType']) || undefined,
  };
}

function readReport(record: Record<string, Json>): ReportDefinition {
  return {
    id: str(record['id']),
    name: str(record['name']) || str(record['title']),
    description: str(record['description']) || undefined,
    subjects: strings(record['subject']),
    scheduleCount: 0,
  };
}

// ---------------------------------------------------------------------------
// Sniffing a JSON file
// ---------------------------------------------------------------------------

/** What kind of content a JSON array holds, from the shape of its first record. */
export function sniffJson(records: readonly Json[]): string {
  const first = records.find(isRecord);
  if (!first) return 'unknown';
  if ('alertDefinitionIdFilters' in first || ('ruleType' in first && 'pluginId' in first)) return 'rules';
  if ('pluginTypeId' in first && 'templateId' in first) return 'templates';
  if ('membershipDefinition' in first) return 'groups';
  if ('formula' in first) return 'super-metrics';
  if ('defaultPolicy' in first) return 'policies';
  if ('states' in first && 'resourceKindKey' in first) return 'alerts';
  if ('state' in first && 'resourceKindKey' in first) return 'symptoms';
  if ('traversal-specs' in first || ('subject' in first && 'name' in first)) return 'reports';
  // Recommendations are the thinnest record in the export: an id and a
  // description and nothing else, which is how they are told apart.
  if ('description' in first && 'id' in first && Object.keys(first).length <= 3) return 'recommendations';
  return 'unknown';
}

function contentFromRecords(name: string, kind: string, records: readonly Json[]): AriaContent {
  const rows = records.filter(isRecord);
  switch (kind) {
    case 'alerts':
      return { ...EMPTY_CONTENT, alerts: rows.map(readAlert), sources: [source(name, 'Alert definitions', rows.length)] };
    case 'symptoms':
      return { ...EMPTY_CONTENT, symptoms: rows.map(readSymptom), sources: [source(name, 'Symptom definitions', rows.length)] };
    case 'recommendations':
      return {
        ...EMPTY_CONTENT,
        recommendations: rows.map((row): Recommendation => ({ id: str(row['id']), description: decodeEntities(str(row['description'])) })),
        sources: [source(name, 'Recommendations', rows.length)],
      };
    case 'groups':
      return { ...EMPTY_CONTENT, groups: rows.map(readGroup), sources: [source(name, 'Custom groups', rows.length)] };
    case 'super-metrics':
      return { ...EMPTY_CONTENT, superMetrics: rows.map((row) => readSuperMetric(str(row['id']), row)), sources: [source(name, 'Super metrics', rows.length)] };
    case 'rules':
      return { ...EMPTY_CONTENT, rules: rows.map(readRule), sources: [source(name, 'Notification rules', rows.length)] };
    case 'templates':
      return { ...EMPTY_CONTENT, templates: rows.map(readTemplate), sources: [source(name, 'Notification templates', rows.length)] };
    case 'reports':
      return { ...EMPTY_CONTENT, reports: rows.map(readReport), sources: [source(name, 'Report definitions', rows.length)] };
    case 'policies':
      return {
        ...EMPTY_CONTENT,
        policies: rows.map((row): PolicySummary => ({
          id: str(row['id']),
          name: str(row['name']),
          isDefault: row['defaultPolicy'] === true,
          priority: num(row['priority']),
        })),
        sources: [source(name, 'Policies', rows.length)],
      };
    default:
      throw new AriaError(`${name} is JSON the toolkit does not recognise. It reads Aria Operations alert, symptom, recommendation, policy, group, super metric, notification and report exports.`);
  }
}

// ---------------------------------------------------------------------------
// The XML exports
// ---------------------------------------------------------------------------

function alertsFromXml(name: string, xml: string): AriaContent {
  const alerts = elements(xml, 'AlertDefinition').map((element): AlertDefinition => {
    const states = elements(element.inner, 'State').map((state): AlertState => ({
      severity: severityOf(state.attrs['severity']),
      symptomIds: elements(state.inner, 'SymptomSet').map((set) => str(set.attrs['ref'])).filter(Boolean),
      operator: str(elements(state.inner, 'SymptomSet')[0]?.attrs['operator']) || 'OR',
      impact: str(elements(state.inner, 'Impact')[0]?.attrs['key']),
      recommendationIds: elements(state.inner, 'Recommendation').map((rec) => str(rec.attrs['ref'])).filter(Boolean),
    }));
    return {
      id: str(element.attrs['id']),
      name: str(element.attrs['name']),
      description: element.attrs['description'] || undefined,
      adapterKind: str(element.attrs['adapterKind']),
      resourceKind: str(element.attrs['resourceKind']),
      states,
      severity: highestSeverity(states.map((state) => state.severity)),
    };
  });
  return { ...EMPTY_CONTENT, alerts, sources: [source(name, 'Alert definitions', alerts.length)] };
}

function symptomsFromXml(name: string, xml: string): AriaContent {
  const symptoms = elements(xml, 'SymptomDefinition').map((element): SymptomDefinition => {
    const state = elements(element.inner, 'State')[0];
    const condition = state ? elements(state.inner, 'Condition')[0] : undefined;
    return {
      id: str(element.attrs['id']),
      name: str(element.attrs['name']),
      adapterKind: str(element.attrs['adapterKind']),
      resourceKind: str(element.attrs['resourceKind']),
      severity: severityOf(state?.attrs['severity']),
      key: condition?.attrs['key'],
      operator: condition?.attrs['operator'],
      value: condition?.attrs['value'],
      thresholdType: condition?.attrs['thresholdType'],
      conditionType: condition?.attrs['type'],
    };
  });
  return { ...EMPTY_CONTENT, symptoms, sources: [source(name, 'Symptom definitions', symptoms.length)] };
}

function recommendationsFromXml(name: string, xml: string): AriaContent {
  const recommendations = elements(xml, 'Recommendation')
    .filter((element) => element.attrs['key'])
    .map((element): Recommendation => ({
      id: str(element.attrs['key']),
      description: decodeEntities(textOf(element.inner, 'Description') ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
    }));
  return { ...EMPTY_CONTENT, recommendations, sources: [source(name, 'Recommendations', recommendations.length)] };
}

function policiesFromXml(name: string, xml: string): AriaContent {
  const policies = elements(xml, 'Policy').map((element): PolicySummary => {
    const alerts = elements(element.inner, 'Alert');
    return {
      id: str(element.attrs['key']),
      name: str(element.attrs['name']),
      isDefault: element.attrs['default'] === 'true',
      description: element.attrs['description'] || undefined,
      parentPolicyId: element.attrs['parentPolicy'] || undefined,
      disabledAlerts: alerts.filter((alert) => alert.attrs['enabled'] === 'false').map((alert) => str(alert.attrs['id'])),
      enabledAlerts: alerts.filter((alert) => alert.attrs['enabled'] === 'true').map((alert) => str(alert.attrs['id'])),
    };
  });
  return { ...EMPTY_CONTENT, policies, sources: [source(name, 'Policies', policies.length)] };
}

function viewsFromXml(name: string, xml: string): AriaContent {
  const views = elements(xml, 'ViewDef').map((element): ViewDefinition => ({
    id: str(element.attrs['id']),
    name: textOf(element.inner, 'Title') ?? '',
    description: textOf(element.inner, 'Description') || undefined,
    subjects: elements(element.inner, 'SubjectType').map((subject) => str(subject.attrs['resourceKind'])).filter(Boolean),
    presentation: elements(element.inner, 'Presentation')[0]?.attrs['type'],
  }));
  return { ...EMPTY_CONTENT, views, sources: [source(name, 'View definitions', views.length)] };
}

function reportsFromXml(name: string, xml: string): AriaContent {
  const reports = elements(xml, 'ReportDef').map((element): ReportDefinition => ({
    id: str(element.attrs['id']),
    name: textOf(element.inner, 'Title') ?? '',
    description: textOf(element.inner, 'Description') || undefined,
    subjects: elements(element.inner, 'SubjectType').map((subject) => str(subject.attrs['resourceKind'])).filter(Boolean),
    scheduleCount: 0,
  }));
  return { ...EMPTY_CONTENT, reports, sources: [source(name, 'Report definitions', reports.length)] };
}

function contentFromXml(name: string, xml: string): AriaContent {
  let content = EMPTY_CONTENT;
  if (xml.includes('<AlertDefinition')) content = merge(content, alertsFromXml(name, xml));
  if (xml.includes('<SymptomDefinition')) content = merge(content, symptomsFromXml(name, xml));
  if (xml.includes('<Recommendation ') || xml.includes('<Recommendation>')) content = merge(content, recommendationsFromXml(name, xml));
  if (xml.includes('<Policy ')) content = merge(content, policiesFromXml(name, xml));
  if (xml.includes('<ViewDef')) content = merge(content, viewsFromXml(name, xml));
  if (xml.includes('<ReportDef')) content = merge(content, reportsFromXml(name, xml));
  if (content.sources.length === 0) {
    throw new AriaError(`${name} is XML the toolkit does not recognise. It reads alertdefs.xml, symptomdefs.xml, policies.xml, recommendationdefs.xml and the views and reports content.`);
  }
  return content;
}

// ---------------------------------------------------------------------------
// Dashboards
// ---------------------------------------------------------------------------

function dashboardsFrom(file: string, json: Json): Dashboard[] {
  if (!isRecord(json)) return [];
  return arr(json['dashboards'])
    .filter(isRecord)
    .map((dashboard): Dashboard => {
      const widgets = arr(dashboard['widgets']).filter(isRecord);
      return {
        id: str(dashboard['id']) || str(dashboard['uuid']) || file,
        name: str(dashboard['name']),
        shared: dashboard['shared'] === true,
        owner: str(dashboard['owner']) || undefined,
        created: num(dashboard['creationTime']),
        columnCount: num(dashboard['columnCount']) ?? 1,
        widgets: widgets.map((widget): DashboardWidget => ({
          type: str(widget['type']) || 'Unknown',
          title: str(widget['title']),
        })),
        viewIds: widgets
          .map((widget) => (isRecord(widget['config']) ? str(widget['config']['viewDefinitionId']) : ''))
          .filter(Boolean),
        file,
      };
    });
}

async function dashboardFromArchive(file: string, bytes: Uint8Array): Promise<Dashboard[]> {
  // Each dashboard in the export is itself a zip holding dashboard.json.
  if (!looksLikeZip(bytes)) {
    return dashboardsFrom(file, parseJson(new TextDecoder().decode(bytes), file));
  }
  const inner = openZip(bytes);
  const entry = inner.names.find((candidate) => candidate.endsWith('dashboard.json'));
  if (!entry) return [];
  return dashboardsFrom(file, parseJson(await inner.text(entry), file));
}

// ---------------------------------------------------------------------------
// The content package
// ---------------------------------------------------------------------------

async function readPackage(name: string, zip: ZipArchive): Promise<AriaContent> {
  let content = EMPTY_CONTENT;

  const readIf = async (entry: string, handle: (text: string) => AriaContent): Promise<void> => {
    if (!zip.has(entry)) return;
    content = merge(content, handle(await zip.text(entry)));
  };

  await readIf('alertdefs.xml', (text) => contentFromXml('alertdefs.xml', text));
  await readIf('symptomdefs.xml', (text) => contentFromXml('symptomdefs.xml', text));
  await readIf('recommendationdefs.xml', (text) => contentFromXml('recommendationdefs.xml', text));
  await readIf('policies.xml', (text) => contentFromXml('policies.xml', text));

  // customgroups.json and notificationrules.json wrap their arrays in an
  // object; supermetrics.json is keyed by id. Each is its own small shape.
  if (zip.has('customgroups.json')) {
    const json = parseJson(await zip.text('customgroups.json'), 'customgroups.json');
    const rows = isRecord(json) ? arr(json['customGroups']).filter(isRecord) : arr(json).filter(isRecord);
    content = merge(content, { ...EMPTY_CONTENT, groups: rows.map(readGroup), sources: [source('customgroups.json', 'Custom groups', rows.length)] });
  }

  if (zip.has('notificationrules.json')) {
    const json = parseJson(await zip.text('notificationrules.json'), 'notificationrules.json');
    const rows = isRecord(json) ? arr(json['NotificationRules']).filter(isRecord) : arr(json).filter(isRecord);
    content = merge(content, { ...EMPTY_CONTENT, rules: rows.map(readRule), sources: [source('notificationrules.json', 'Notification rules', rows.length)] });
  }

  if (zip.has('supermetrics.json')) {
    const json = parseJson(await zip.text('supermetrics.json'), 'supermetrics.json');
    const metrics: SuperMetric[] = isRecord(json)
      ? Object.entries(json)
          .filter(([, value]) => isRecord(value))
          .map(([id, value]) => readSuperMetric(id, value as Record<string, Json>))
      : arr(json).filter(isRecord).map((row) => readSuperMetric(str(row['id']), row));
    content = merge(content, { ...EMPTY_CONTENT, superMetrics: metrics, sources: [source('supermetrics.json', 'Super metrics', metrics.length)] });
  }

  // views.zip and reports.zip are nested archives holding one content.xml each.
  for (const nested of ['views.zip', 'reports.zip']) {
    if (!zip.has(nested)) continue;
    try {
      const innerZip = openZip(await zip.bytes(nested));
      const entry = innerZip.names.find((candidate) => candidate.endsWith('.xml'));
      if (entry) content = merge(content, contentFromXml(nested, await innerZip.text(entry)));
    } catch {
      // A nested archive the platform cannot inflate is not worth failing the
      // whole read over; the rest of the package is still useful.
    }
  }

  // One zip per dashboard, under dashboards/.
  const dashboardFiles = zip.names.filter((entry) => entry.startsWith('dashboards/') && !entry.endsWith('/'));
  const dashboards: Dashboard[] = [];
  for (const entry of dashboardFiles) {
    try {
      dashboards.push(...(await dashboardFromArchive(entry.slice('dashboards/'.length), await zip.bytes(entry))));
    } catch {
      // Same reasoning: one unreadable dashboard should not lose the other 305.
    }
  }
  if (dashboards.length > 0) {
    content = merge(content, { ...EMPTY_CONTENT, dashboards, sources: [source(`${name} · dashboards`, 'Dashboards', dashboards.length)] });
  }

  // Report schedules say which report definitions actually run.
  const scheduleCounts = new Map<string, number>();
  for (const entry of zip.names.filter((candidate) => candidate.startsWith('reportschedules/') && !candidate.endsWith('/'))) {
    try {
      const json = parseJson(await zip.text(entry), entry);
      const schedules = isRecord(json) ? arr(json['reportSchedules']).filter(isRecord) : arr(json).filter(isRecord);
      for (const schedule of schedules) {
        const reportId = str(schedule['reportDefinitionID']);
        if (reportId) scheduleCounts.set(reportId, (scheduleCounts.get(reportId) ?? 0) + 1);
      }
    } catch {
      // ignore an unreadable schedule
    }
  }
  if (scheduleCounts.size > 0) {
    content = {
      ...content,
      reports: content.reports.map((report) => ({ ...report, scheduleCount: scheduleCounts.get(report.id) ?? 0 })),
    };
  }

  if (content.sources.length === 0) {
    throw new AriaError(`${name} is a zip, but not one the toolkit recognises. Export the content package from Aria Operations, or the dashboards folder from it.`);
  }
  return content;
}

// ---------------------------------------------------------------------------
// The entry point
// ---------------------------------------------------------------------------

/**
 * Read one dropped file, whatever it turns out to be.
 *
 * The name is used for the sources list and for error messages, never to decide
 * what the file is — an export renamed on the way out of a change ticket still
 * has to read.
 */
export async function readAriaFile(name: string, data: Uint8Array | ArrayBuffer): Promise<AriaContent> {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (bytes.length === 0) throw new AriaError(`${name} is empty.`);

  if (looksLikeZip(bytes)) {
    let zip: ZipArchive;
    try {
      zip = openZip(bytes);
    } catch (error) {
      throw new AriaError(`${name} could not be opened: ${error instanceof ZipError ? error.message : String(error)}`);
    }
    // A bare dashboard archive, dropped on its own.
    if (zip.names.some((entry) => entry.endsWith('dashboard/dashboard.json'))) {
      const dashboards = await dashboardFromArchive(name, bytes);
      return { ...EMPTY_CONTENT, dashboards, sources: [source(name, 'Dashboards', dashboards.length)] };
    }
    return readPackage(name, zip);
  }

  const text = stripBom(new TextDecoder().decode(bytes)).trim();
  if (text.startsWith('<')) return contentFromXml(name, text);

  const json = parseJson(text, name);
  if (Array.isArray(json)) return contentFromRecords(name, sniffJson(json), json);

  if (isRecord(json)) {
    // The wrapper shapes the appliance writes.
    if (Array.isArray(json['NotificationRules'])) return contentFromRecords(name, 'rules', json['NotificationRules']);
    if (Array.isArray(json['customGroups'])) return contentFromRecords(name, 'groups', json['customGroups']);
    if (Array.isArray(json['reportSchedules'])) {
      const rows = arr(json['reportSchedules']).filter(isRecord);
      return { ...EMPTY_CONTENT, sources: [source(name, 'Report schedules', rows.length)] };
    }
    if (Array.isArray(json['dashboards'])) {
      const dashboards = dashboardsFrom(name, json);
      return { ...EMPTY_CONTENT, dashboards, sources: [source(name, 'Dashboards', dashboards.length)] };
    }
    // supermetrics.json is an object keyed by id.
    const values = Object.values(json).filter(isRecord);
    if (values.length > 0 && values.every((value) => 'formula' in value)) {
      const metrics = Object.entries(json)
        .filter(([, value]) => isRecord(value))
        .map(([id, value]) => readSuperMetric(id, value as Record<string, Json>));
      return { ...EMPTY_CONTENT, superMetrics: metrics, sources: [source(name, 'Super metrics', metrics.length)] };
    }
  }

  throw new AriaError(`${name} is not an Aria Operations export the toolkit recognises.`);
}

/** Read several dropped files into one set of content. */
export async function readAriaFiles(files: readonly { readonly name: string; readonly data: Uint8Array | ArrayBuffer }[]): Promise<{ content: AriaContent; errors: readonly string[] }> {
  let content = EMPTY_CONTENT;
  const errors: string[] = [];
  for (const file of files) {
    try {
      content = merge(content, await readAriaFile(file.name, file.data));
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  return { content, errors };
}
