/**
 * Aria Operations content, as something you can read.
 *
 * vROps 8.x and VCF Operations 9.x will export what is configured in them —
 * alert and symptom definitions, recommendations, policies, custom groups,
 * super metrics, notification rules, reports, dashboards — and the export is
 * accurate and unreadable. Alert definitions come out as a 5 MB JSON array;
 * dashboards come out as a zip of zips, one archive per dashboard, each one
 * holding a `dashboard.json` with the widget layout in it. Nobody reviews that.
 *
 * Which is the problem, because the questions people actually have about a
 * monitoring platform are questions about the whole of it, not about one
 * object: which alerts is nobody being told about, which symptoms does nothing
 * reference any more, which groups are still on the default policy, which
 * dashboards are duplicates of each other, which reports are defined and never
 * run. Those are answerable from these files and from nowhere else.
 *
 * So this reads the export into one shape, and `findings.ts` asks those
 * questions of it. Nothing leaves the browser: the files are read where they
 * are dropped, and the toolkit has no network calls to make.
 */

export type AriaSeverity = 'critical' | 'immediate' | 'warning' | 'info' | 'auto' | 'unknown';

export interface AlertState {
  readonly severity: AriaSeverity;
  /** The symptoms that have to be true. */
  readonly symptomIds: readonly string[];
  /** How the symptoms combine: AND or OR. */
  readonly operator: string;
  /** Which badge it affects: health, risk, efficiency. */
  readonly impact: string;
  readonly recommendationIds: readonly string[];
}

export interface AlertDefinition {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly adapterKind: string;
  readonly resourceKind: string;
  readonly waitCycles?: number;
  readonly cancelCycles?: number;
  readonly states: readonly AlertState[];
  /** Highest severity across its states, for sorting and counting. */
  readonly severity: AriaSeverity;
}

export interface SymptomDefinition {
  readonly id: string;
  readonly name: string;
  readonly adapterKind: string;
  readonly resourceKind: string;
  readonly severity: AriaSeverity;
  readonly waitCycles?: number;
  readonly cancelCycles?: number;
  /** The metric or property being tested. */
  readonly key?: string;
  readonly operator?: string;
  readonly value?: string;
  /** STATIC, or a dynamic threshold Aria works out for itself. */
  readonly thresholdType?: string;
  readonly conditionType?: string;
}

export interface Recommendation {
  readonly id: string;
  readonly description: string;
}

export interface PolicySummary {
  readonly id: string;
  readonly name: string;
  readonly isDefault: boolean;
  /** Where it sits in the priority order, when it has one. */
  readonly priority?: number;
  readonly description?: string;
  readonly parentPolicyId?: string;
  /** Alert definitions this policy turns off, from policies.xml. */
  readonly disabledAlerts?: readonly string[];
  /** Alert definitions this policy turns on, from policies.xml. */
  readonly enabledAlerts?: readonly string[];
}

export interface GroupRule {
  readonly resourceKind: string;
  readonly adapterKind: string;
  readonly conditions: readonly string[];
}

export interface CustomGroup {
  readonly id: string;
  readonly name: string;
  readonly groupKind: string;
  readonly policyId?: string;
  readonly autoResolve: boolean;
  readonly rules: readonly GroupRule[];
  /** Members named one at a time rather than by a rule. */
  readonly explicitMembers: number;
  readonly excludedMembers: number;
}

export interface SuperMetric {
  readonly id: string;
  readonly name: string;
  readonly formula: string;
  readonly description?: string;
  readonly modified?: number;
  /** Other super metrics this one reads, by id. */
  readonly dependsOn: readonly string[];
}

export interface NotificationRule {
  readonly id: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly templateId?: string;
  readonly ruleType: string;
  readonly criticalities: readonly string[];
  readonly alertStatuses: readonly string[];
  /** Named alert definitions this rule is limited to. Empty means all of them. */
  readonly alertDefinitionIds: readonly string[];
  /** Object kinds it is limited to. Empty means all of them. */
  readonly resourceKinds: readonly string[];
  readonly impacts: readonly string[];
  /** Plugin settings — where it sends, how often it resends. */
  readonly properties: Readonly<Record<string, string>>;
}

export interface NotificationTemplate {
  readonly id: string;
  readonly name: string;
  readonly pluginTypeId: string;
  readonly attachedRuleCount: number;
  readonly editable: boolean;
  readonly templateType?: string;
}

export interface ReportDefinition {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly subjects: readonly string[];
  /** Report schedule ids that run it, filled in from the export's schedules. */
  readonly scheduleCount: number;
}

export interface DashboardWidget {
  readonly type: string;
  readonly title: string;
}

export interface ViewDefinition {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly subjects: readonly string[];
  /** LIST, DISTRIBUTION, TREND, SUMMARY, TEXT — what it draws. */
  readonly presentation?: string;
}

export interface Dashboard {
  /** The dashboard's own id, which is also the file name in the export. */
  readonly id: string;
  readonly name: string;
  readonly shared: boolean;
  readonly owner?: string;
  readonly created?: number;
  readonly columnCount: number;
  readonly widgets: readonly DashboardWidget[];
  /** View definitions its View widgets show, by id. */
  readonly viewIds: readonly string[];
  /** The export file this one came out of, since one file can hold several. */
  readonly file: string;
}

/** Where each part of the content came from, so the page can say what is missing. */
export interface AriaSource {
  readonly name: string;
  readonly kind: string;
  readonly records: number;
}

export interface AriaContent {
  readonly alerts: readonly AlertDefinition[];
  readonly symptoms: readonly SymptomDefinition[];
  readonly recommendations: readonly Recommendation[];
  readonly policies: readonly PolicySummary[];
  readonly groups: readonly CustomGroup[];
  readonly superMetrics: readonly SuperMetric[];
  readonly rules: readonly NotificationRule[];
  readonly templates: readonly NotificationTemplate[];
  readonly reports: readonly ReportDefinition[];
  readonly views: readonly ViewDefinition[];
  readonly dashboards: readonly Dashboard[];
  readonly sources: readonly AriaSource[];
}

export const EMPTY_CONTENT: AriaContent = {
  alerts: [],
  symptoms: [],
  recommendations: [],
  policies: [],
  groups: [],
  superMetrics: [],
  rules: [],
  templates: [],
  reports: [],
  views: [],
  dashboards: [],
  sources: [],
};

export function isEmpty(content: AriaContent): boolean {
  return (
    content.alerts.length === 0 &&
    content.symptoms.length === 0 &&
    content.recommendations.length === 0 &&
    content.policies.length === 0 &&
    content.groups.length === 0 &&
    content.superMetrics.length === 0 &&
    content.rules.length === 0 &&
    content.templates.length === 0 &&
    content.reports.length === 0 &&
    content.views.length === 0 &&
    content.dashboards.length === 0
  );
}

/**
 * Merge two reads, so several files can be dropped one at a time.
 *
 * Field by field rather than record by record, because the same object arrives
 * in two shapes: the XML in the content package carries the policy's disabled
 * alerts and the alert's readable name, while the JSON inventory pulled from
 * the API carries the whole estate. Letting the later file replace the record
 * outright threw away whichever half was richer, which showed up as a policy
 * that suddenly disabled nothing and a report that was never scheduled.
 */
export function merge(a: AriaContent, b: AriaContent): AriaContent {
  const worth = (value: unknown): boolean => {
    if (value === undefined || value === null || value === '') return false;
    if (Array.isArray(value)) return value.length > 0;
    return true;
  };

  const combine = <T extends { id: string }>(left: T, right: T): T => {
    const out: Record<string, unknown> = { ...left };
    for (const [key, value] of Object.entries(right)) {
      if (worth(value)) out[key] = value;
    }
    // A count of zero from one file must not overwrite a real count from
    // another, whichever order they were dropped in.
    for (const key of ['scheduleCount', 'attachedRuleCount']) {
      const before = (left as Record<string, unknown>)[key];
      const after = (right as Record<string, unknown>)[key];
      if (typeof before === 'number' && typeof after === 'number') out[key] = Math.max(before, after);
    }
    return out as T;
  };

  const pick = <T extends { id: string }>(left: readonly T[], right: readonly T[]): readonly T[] => {
    if (right.length === 0) return left;
    if (left.length === 0) return right;
    const merged = new Map(left.map((item) => [item.id, item]));
    for (const item of right) {
      const already = merged.get(item.id);
      merged.set(item.id, already ? combine(already, item) : item);
    }
    return [...merged.values()];
  };

  return {
    alerts: pick(a.alerts, b.alerts),
    symptoms: pick(a.symptoms, b.symptoms),
    recommendations: pick(a.recommendations, b.recommendations),
    policies: pick(a.policies, b.policies),
    groups: pick(a.groups, b.groups),
    superMetrics: pick(a.superMetrics, b.superMetrics),
    rules: pick(a.rules, b.rules),
    templates: pick(a.templates, b.templates),
    reports: pick(a.reports, b.reports),
    views: pick(a.views, b.views),
    dashboards: pick(a.dashboards, b.dashboards),
    sources: [...a.sources, ...b.sources],
  };
}

const SEVERITY_ORDER: Readonly<Record<AriaSeverity, number>> = {
  critical: 5,
  immediate: 4,
  warning: 3,
  info: 2,
  auto: 1,
  unknown: 0,
};

export function severityOf(text: string | undefined): AriaSeverity {
  const lowered = String(text ?? '').toLowerCase();
  if (lowered === 'critical') return 'critical';
  if (lowered === 'immediate') return 'immediate';
  if (lowered === 'warning') return 'warning';
  if (lowered === 'info' || lowered === 'information') return 'info';
  if (lowered === 'auto') return 'auto';
  return 'unknown';
}

export function highestSeverity(values: readonly AriaSeverity[]): AriaSeverity {
  let best: AriaSeverity = 'unknown';
  for (const value of values) {
    if (SEVERITY_ORDER[value] > SEVERITY_ORDER[best]) best = value;
  }
  return best;
}

/**
 * What an object's severity means when Aria says AUTO.
 *
 * AUTO does not mean "no severity" — it means the alert takes the severity of
 * whichever symptom fired, which is worth saying on the page because a column
 * full of AUTO otherwise reads as missing data.
 */
export const SEVERITY_MEANING: Readonly<Record<AriaSeverity, string>> = {
  critical: 'Critical — the highest severity Aria raises.',
  immediate: 'Immediate — below critical, above warning.',
  warning: 'Warning.',
  info: 'Information only.',
  auto: 'Takes the severity of whichever symptom fired, rather than a fixed one.',
  unknown: 'The export did not say.',
};

/** Count by a key, highest first — used for every census on the page. */
export function countBy<T>(items: readonly T[], key: (item: T) => string): readonly { readonly name: string; readonly count: number }[] {
  const counts = new Map<string, number>();
  for (const item of items) {
    const name = key(item) || '(none)';
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}
