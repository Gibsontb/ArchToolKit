/**
 * The widget catalogue against its two sources of truth: Broadcom's widget
 * definitions list (every widget it names is in the catalogue, deprecated
 * where it says so) and a real content export (every widget type it holds is
 * in the catalogue, every config key it holds is a setting or explicitly
 * passed through, and a widget built with every option set has the export's
 * shape). The export's shape is in src/testing/vcf-ops-export-shapes.ts, keys
 * and types only; when the export itself is at private/aria/dashboards.zip,
 * the full load → generate round trip of every dashboard in it runs too.
 */

import { describe, it } from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import { expect } from '../testing/expect.ts';
import { defaultValues } from '../kit/blueprint.ts';
import { readDashboardExports } from '../aria/parse.ts';
import { EXPORT_DASHBOARD_KEYS, EXPORT_SHAPES } from '../testing/vcf-ops-export-shapes.ts';
import { dashboardChoices, deepEqual, loadDashboard } from './blueprints/vcf-ops-dashboard-import.ts';
import { VCF_OPS_BUILD } from './blueprints/vcf-ops-build.ts';
import { DASHBOARD_KEYS, ROW_KEYS, Settings, WIDGET_TYPES, filterText, parseFilter, settingProblems, widgetType, type WidgetSetting, type WidgetType } from './blueprints/vcf-ops-widgets.ts';

const DASHBOARD = VCF_OPS_BUILD.find((b) => b.id === 'vcfops_dashboard')!;
const BASE = defaultValues(DASHBOARD);
/** The customer export, when it is here (it is private and never in the repo). */
const PRIVATE_EXPORT = decodeURIComponent(new URL('../../private/aria/dashboards.zip', import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1');

/** VCF Operations 9.1's widget definitions list (44 widgets), and Geo from 9.0's. */
const DOCS_WIDGETS = [
  'Alert List', 'Alert Volume', 'Anomalies', 'Anomaly Breakdown', 'Capacity Remaining', 'Container Details', 'Container Overview', 'Current Policy', 'Data Collection Results',
  'DRS Cluster Settings', 'Efficiency', 'Environment', 'Environment Overview', 'Environment Status', 'Faults', 'Forensics', 'Heat Map', 'Health', 'Health Chart', 'Log Analysis',
  'Mashup Chart', 'Metric Chart', 'Metric Picker', 'Object List', 'Object Relationship', 'Object Relationship (Advanced)', 'Property List', 'PromQL Viewer', 'Recommended Actions',
  'Risk', 'Rolling View Chart', 'Scoreboard', 'Scoreboard Health', 'Sparkline Chart', 'Tag Picker', 'Text Display', 'Time Remaining', 'Top Alerts', 'Top-N', 'Topology Graph', 'View',
  'Weather Map', 'Workload', 'Workload Pattern', 'Geo',
];
/** "Widget or View List Details": the deprecated widgets. */
const DOCS_DEPRECATED = ['Current Policy', 'Weather Map', 'Anomalies', 'DRS Cluster Settings', 'Efficiency', 'Environment Status', 'Risk', 'Environment', 'Container Overview', 'Faults'];

const jsonType = (v: unknown): string => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);

/** A value for a setting that is set, and not its default. */
function sample(type: WidgetType, setting: WidgetSetting): string {
  const byKey: Record<string, string> = {
    view: 'Cluster capacity overview',
    pin: 'host:esx-01',
    refresh: '120',
    definitions: 'AlertDefinition-VMWARE-HostLowMemory',
    columnlabels: 'CPU,Memory',
    objectmetrics: 'vm:web-01=cpu|usage_average',
    labels: 'CPU,Memory',
    description: 'What this widget shows',
    detailsurl: '/vcf-operations/ui/inventory',
    link: '/vcf-operations/ui/inventory',
    metricconfig: 'metric_config.xml',
    metriclabel: 'IOPS',
    metricname: 'CPU|Usage (%)',
    group: 'Production',
    grouptype: 'Function',
    configname: 'Utilization',
    thresholds: '70,80,90',
    values: '0,70,90',
    colors: '#00FF00,#FFFF00,#FF0000',
    groupby: 'host',
    url: 'https://example.com/status',
    file: 'about.html',
    query: 'sum(rate(cpu_usage[5m]))',
    text: 'Hello; with = and ; kept',
    html: '<b>bold</b>',
    depth: type.type === 'ResourceRelationshipAdvanced' ? '1,1' : '3',
  };
  if (byKey[setting.key] !== undefined) return byKey[setting.key]!;
  switch (setting.type) {
    case 'kind':
      return 'cluster';
    case 'kinds':
      return 'cluster,host';
    case 'metric':
      return 'cpu|usage_average';
    case 'text':
      if (setting.options) return setting.options.find((o) => o !== setting.default) ?? 'custom.xml';
      return 'x';
    case 'metrics':
      return 'cpu|usage_average,mem|usage_average';
    case 'number':
      return String(Math.max(setting.min ?? 1, Math.min(setting.max ?? 50, 3)));
    case 'numbers':
      return '1,2,3';
    case 'choice': {
      const options = setting.options ?? [];
      return options.find((o) => o !== setting.default) ?? options[0] ?? '';
    }
    case 'choices':
      return (setting.options ?? []).slice(0, 2).join(',');
    case 'yesno':
      return setting.default === 'yes' ? 'no' : 'yes';
    case 'colors':
      return '#8ABF5B,#EACC58,#E4695E';
    case 'filter':
      return 'metric cpu|usage_average GREATER_THAN 80 & name CONTAINS web & relationship DESCENDANT EQUALS Production';
    case 'objects':
      return 'vm:web-01,host:esx-01';
    default:
      return setting.options?.[0] ?? 'x';
  }
}

function everyOption(type: WidgetType): string {
  const pairs = type.settings.map((setting) => [setting.key, sample(type, setting)] as const).filter(([, v]) => v !== '');
  // text= and html= take the rest of the cell, so they go last (and only one of them).
  const rest = pairs.filter(([k]) => k === 'text' || k === 'html' || k === 'query').slice(0, 1);
  return [...pairs.filter(([k]) => k !== 'text' && k !== 'html' && k !== 'query'), ...rest].map(([k, v]) => `${k}=${v}`).join('; ');
}

interface Built {
  widgets: { type: string; title: string; collapsed: boolean; config: Record<string, unknown> }[];
}

function buildEveryOption(): { json: Built; errors: string[] } {
  const rows = WIDGET_TYPES.map((type) => `${type.type} | ${type.label} everything | ${everyOption(type)} | auto | yes | `);
  const out = DASHBOARD.build({ ...BASE, template: 'custom', widgets_custom: rows.join('\n'), max_widgets: 100 }, 'test');
  const errors = (out.findings ?? []).filter((f) => f.severity === 'error').map((f) => `${f.code}: ${f.message}`);
  return { json: (JSON.parse(out.files['import/dashboard.json'] ?? '{}') as { dashboards: Built[] }).dashboards[0]!, errors };
}

describe('the widget catalogue: Broadcom’s widget definitions list', () => {
  it('has every widget the 9.1 list names (and Geo from 9.0), each with its page', () => {
    for (const name of DOCS_WIDGETS) {
      const type = widgetType(name);
      expect(type?.label).toBe(name);
      expect(type!.doc?.startsWith('https://techdocs.broadcom.com/')).toBe(true);
    }
  });

  it('marks exactly the widgets the docs deprecate', () => {
    const deprecated = WIDGET_TYPES.filter((t) => t.deprecated).map((t) => t.label).sort();
    expect(deprecated).toEqual([...DOCS_DEPRECATED].sort());
  });

  it('flags every type or key it infers, and says why', () => {
    for (const type of WIDGET_TYPES.filter((t) => !t.verified)) expect(Boolean(type.note) || type.source.includes('no export')).toBe(true);
    for (const type of WIDGET_TYPES) {
      expect(new Set(type.settings.map((s) => s.key)).size).toBe(type.settings.length);
      for (const setting of type.settings) expect(setting.help.length).toBeGreaterThan(5);
    }
    // Every setting of a documented widget names the dialog option it is, and every doc link is Broadcom's.
    for (const type of WIDGET_TYPES) for (const setting of type.settings) if (setting.doc) expect(setting.doc.startsWith('https://techdocs.broadcom.com/')).toBe(true);
  });
});

describe('the widget catalogue: a real content export', () => {
  it('has every widget type the export holds', () => {
    for (const type of Object.keys(EXPORT_SHAPES)) expect(widgetType(type)?.type).toBe(type);
  });

  it('writes every config key the export holds, or passes it through with a reason', () => {
    const missing: string[] = [];
    for (const [typeName, shape] of Object.entries(EXPORT_SHAPES)) {
      const type = widgetType(typeName)!;
      const covered = new Set([...Object.keys(ROW_KEYS), ...type.settings.flatMap((s) => s.writes ?? []), ...Object.keys(type.passthrough ?? {})]);
      for (const key of Object.keys(shape.keys)) if (!covered.has(key)) missing.push(`${typeName}.${key}`);
      for (const reason of Object.values(type.passthrough ?? {})) expect(reason.length).toBeGreaterThan(10);
    }
    expect(missing).toEqual([]);
  });

  it('knows every dashboard-level key the export holds', () => {
    for (const key of EXPORT_DASHBOARD_KEYS) expect(Boolean(DASHBOARD_KEYS[key]?.field || DASHBOARD_KEYS[key]?.kept)).toBe(true);
  });

  it('builds every widget with every option set, clean, in the shape the export has', () => {
    const { json, errors } = buildEveryOption();
    expect(errors).toEqual([]);
    const problems: string[] = [];
    for (const type of WIDGET_TYPES) {
      const widget = json.widgets.find((w) => w.title === `${type.label} everything`)!;
      expect(widget.type).toBe(type.type);
      const shape = EXPORT_SHAPES[type.type];
      if (!shape) continue;
      // A key an inferred option writes, or one the export only ever left unset, is checked against where it was seen instead.
      const elsewhere = new Set(type.settings.filter((s) => s.unverified || s.seenElsewhere).flatMap((s) => s.writes ?? []));
      const allowed = new Set([...Object.keys(shape.keys), ...Object.keys(type.alsoWrites ?? {}), ...elsewhere]);
      for (const [key, value] of Object.entries(widget.config)) {
        if (!allowed.has(key)) problems.push(`${type.type}.${key} is not a key the export holds`);
        const seen = shape.keys[key];
        if (!seen || elsewhere.has(key)) continue;
        if (!seen.types.includes(jsonType(value))) problems.push(`${type.type}.${key} is ${jsonType(value)}, the export has ${seen.types.join('/')}`);
        if (seen.sub && jsonType(value) === 'object') {
          for (const [k2, v2] of Object.entries(value as Record<string, unknown>)) {
            if (!seen.sub[k2]) problems.push(`${type.type}.${key}.${k2} is not a key the export holds`);
            else if (!seen.sub[k2]!.includes(jsonType(v2))) problems.push(`${type.type}.${key}.${k2} is ${jsonType(v2)}, the export has ${seen.sub[k2]!.join('/')}`);
          }
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it('sets every option it writes: each setting changes the widget’s config', () => {
    const unchanged: string[] = [];
    for (const type of WIDGET_TYPES) {
      const base = (row: string) => DASHBOARD.build({ ...BASE, template: 'custom', widgets_custom: row }, 'test');
      const configOf = (settings: string) => {
        const out = base(`${type.type} | W | ${settings} | auto | yes | `);
        const json = JSON.parse(out.files['import/dashboard.json']!) as { dashboards: Built[]; entries: unknown };
        const widget = json.dashboards[0]!.widgets[0]!;
        return { config: widget.config, collapsed: widget.collapsed, entries: json.entries };
      };
      // Settings that only matter beside another: a group's type, a column's label, a metric's label, threshold and unit.
      const needs: Record<string, string> = { grouptype: 'group', columnlabels: 'columns', labels: 'metrics', thresholds: 'metrics', unit: 'metrics' };
      const has = new Set(type.settings.map((s) => s.key));
      const required = type.settings.filter((s) => s.required || (Object.values(needs).includes(s.key) && s.key === 'metrics')).map((s) => `${s.key}=${sample(type, s)}`);
      const plain = configOf(required.join('; '));
      for (const setting of type.settings.filter((s) => !required.some((r) => r.startsWith(`${s.key}=`)) && s.key !== 'refresh' && s.key !== 'filterkind')) {
        const value = sample(type, setting);
        const partner = needs[setting.key];
        const withPartner = partner && has.has(partner) && !required.some((r) => r.startsWith(`${partner}=`)) ? [`${partner}=${sample(type, type.settings.find((s) => s.key === partner)!)}`] : [];
        const before = partner ? configOf([...required, ...withPartner].join('; ')) : plain;
        const next = configOf([...required, ...withPartner, `${setting.key}=${value}`].join('; '));
        if (deepEqual(before, next)) unchanged.push(`${type.type} ${setting.key}=${value}`);
      }
    }
    expect(unchanged).toEqual([]);
  });
});

describe('the Output Filter rules', () => {
  it('reads and writes each rule as the export has it', () => {
    const { rules, problems } = parseFilter('metric cpu|usage_average GREATER_THAN 80 & property summary|tag CONTAINS prod & name NOT_EQUALS vc 01 & relationship DESCENDANT EQUALS SDDC Health');
    expect(problems).toEqual([]);
    expect(rules.map((r) => r.kind)).toEqual(['metric', 'property', 'name', 'relationship']);
    expect(parseFilter('size GREATER_THAN 3').problems.length).toBe(1);
    const { json } = buildEveryOption();
    const list = json.widgets.find((w) => w.type === 'ResourceList')!.config;
    expect(list['filterMode']).toBe('customFilter');
    const block = list['customFilter'] as { filter: { resourceKind: string; filterTypes: Record<string, unknown>[] }[] };
    expect(block.filter[0]!.filterTypes[0]).toEqual({ condition: 'GREATER_THAN', metricKey: 'cpu|usage_average', metricValue: { isStringMetric: false, value: 80 }, filterType: 'metrics' });
    expect(block.filter[0]!.filterTypes[2]).toEqual({ condition: 'EQUALS', traversalSpec: null, relValue: 'Production', relType: 'DESCENDANT', filterType: 'relationship' });
    expect(filterText(block)?.filter).toBe('metric cpu|usage_average GREATER_THAN 80 & name CONTAINS web & relationship DESCENDANT EQUALS Production');
    expect(settingProblems(widgetType('ResourceList')!, new Settings('filter=metric cpu|usage_average ABOVE 80'), true).errors.length).toBe(1);
  });
});

describe('the widget catalogue: the whole export, load → generate', { skip: !existsSync(PRIVATE_EXPORT) && 'private/aria/dashboards.zip is not here' }, () => {
  it('writes every dashboard back exactly as exported, with no edits', async () => {
    const exports = await readDashboardExports('dashboards.zip', new Uint8Array(readFileSync(PRIVATE_EXPORT)));
    const choices = dashboardChoices(exports);
    expect(choices.length).toBeGreaterThan(0);
    const differ: string[] = [];
    for (const choice of choices) {
      const exp = exports[choice.exportIndex]!;
      const loaded = loadDashboard(exp, choice.dashboardIndex, exports);
      const out = DASHBOARD.build({ ...BASE, ...loaded.values }, 'rt');
      const json = JSON.parse(out.files['import/dashboard.json']!) as { dashboards: unknown[]; entries: unknown };
      const errors = (out.findings ?? []).filter((f) => f.severity === 'error');
      if (errors.length > 0 || !deepEqual(json.dashboards[0], (exp.json['dashboards'] as unknown[])[choice.dashboardIndex]) || !deepEqual(json.entries, exp.json['entries'])) differ.push(`dashboard ${choice.exportIndex}/${choice.dashboardIndex}`);
    }
    expect(differ).toEqual([]);
  });

  it('holds no config key the catalogue neither writes nor passes through', async () => {
    const exports = await readDashboardExports('dashboards.zip', new Uint8Array(readFileSync(PRIVATE_EXPORT)));
    const missing = new Set<string>();
    for (const exp of exports) {
      for (const dashboard of (exp.json['dashboards'] as { widgets?: { type: string; config?: Record<string, unknown> }[] }[]) ?? []) {
        for (const widget of dashboard.widgets ?? []) {
          const type = widgetType(widget.type);
          if (!type) {
            missing.add(widget.type);
            continue;
          }
          const covered = new Set([...Object.keys(ROW_KEYS), ...type.settings.flatMap((s) => s.writes ?? []), ...Object.keys(type.passthrough ?? {})]);
          for (const key of Object.keys(widget.config ?? {})) if (!covered.has(key)) missing.add(`${widget.type}.${key}`);
        }
      }
    }
    expect([...missing]).toEqual([]);
  });
});
