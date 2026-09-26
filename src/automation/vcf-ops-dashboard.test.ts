/**
 * The VCF Operations dashboard builder: every standard dashboard builds clean,
 * every widget type in the catalogue builds into a dashboard, the grid packs
 * without overlaps, "Receives from" becomes widgetInteractions, every check on
 * the widget grid fires on the row that breaks it, and what is written reads
 * back through the VCF Ops content page's own reader of real exports.
 */

import { describe, it } from 'node:test';
import { expect } from '../testing/expect.ts';
import { defaultValues, type BlueprintValues } from '../kit/blueprint.ts';
import type { Finding } from '../core/findings.ts';
import { zip } from '../kit/archive.ts';
import { openZip } from '../core/zip.ts';
import { readAriaFile, readDashboardExports, readViewDefs } from '../aria/parse.ts';
import { dashboardChoices, loadDashboard } from './blueprints/vcf-ops-dashboard-import.ts';
import { __test as builderRows } from '../ui/dashboard-builder.ts';
import { tableShape } from '../ui/multi-editors.ts';
import { VCF_OPS_BUILD, layoutWidgets, parseWidgetRows } from './blueprints/vcf-ops-build.ts';
import { Settings, WIDGET_TYPES, metricKeyProblem, parseKind, type WidgetType } from './blueprints/vcf-ops-widgets.ts';
import { stableId } from './vcfops-import.ts';

const DASHBOARD = VCF_OPS_BUILD.find((b) => b.id === 'vcfops_dashboard')!;
const VIEW = VCF_OPS_BUILD.find((b) => b.id === 'vcfops_view')!;
const BASE = defaultValues(DASHBOARD);
const TEMPLATES = (DASHBOARD.inputs.find((i) => i.id === 'template')?.options ?? []).map((o) => o.value);

interface DashboardJson {
  entries: { resourceKind: { internalId: string; adapterKindKey: string; resourceKindKey: string }[]; resource: { internalId: string; name: string }[] };
  dashboards: {
    id: string;
    name: string;
    namePath: string;
    shared: boolean;
    homeTab: boolean;
    locked: boolean;
    autoswitchEnabled: boolean;
    states: { key: string; value: string }[];
    dashboardNavigations: Record<string, { id: string; widgets: unknown[] }[]>;
    widgetInteractions: { type: string; widgetIdProvider: string; widgetIdReceiver: string }[];
    widgets: { id: string; type: string; title: string; gridsterCoords: { x: number; y: number; w: number; h: number }; config: Record<string, unknown> }[];
  }[];
  uuid: string;
}

/** Build with the template's grid replaced by these rows (Type | Title | Settings | Position | Provider | Receives from). */
function build(rows: readonly string[] | undefined, extra: BlueprintValues = {}): { files: Record<string, string>; findings: readonly Finding[]; json: DashboardJson } {
  const template = String(extra['template'] ?? 'custom');
  const values: BlueprintValues = { ...BASE, template, ...(rows ? { [`widgets_${template}`]: rows.join('\n') } : {}), ...extra };
  const out = DASHBOARD.build(values, 'test');
  return { files: { ...out.files }, findings: out.findings ?? [], json: JSON.parse(out.files['import/dashboard.json'] ?? '{}') as DashboardJson };
}

const errors = (findings: readonly Finding[]): string[] => findings.filter((f) => f.severity === 'error').map((f) => `${f.code}: ${f.message}`);
const codes = (findings: readonly Finding[]): string[] => findings.filter((f) => f.severity === 'error').map((f) => f.code);

/** Settings that satisfy a type's required ones (and the either-or ones). */
function sampleSettings(type: WidgetType): string {
  const parts: string[] = [];
  for (const setting of type.settings) {
    if (!setting.required) continue;
    if (setting.type === 'kind') parts.push(`${setting.key}=cluster`);
    else if (setting.type === 'kinds') parts.push(`${setting.key}=cluster,host`);
    else if (setting.type === 'metric') parts.push(`${setting.key}=cpu|usage_average`);
    else if (setting.type === 'metrics') parts.push(`${setting.key}=cpu|usage_average,mem|usage_average`);
    else if (setting.key === 'view') parts.push('view=Cluster capacity overview');
    else parts.push(`${setting.key}=x`);
  }
  if (type.type === 'PropertyList') parts.push('props=config|name');
  if (type.type === 'TextDisplay') parts.push('text=Hello; with = and ; kept');
  return parts.join('; ');
}

async function fromArchive(files: Record<string, string>, path: string): Promise<Uint8Array> {
  return openZip(await zip(files)).bytes(path);
}

describe('vcfops_dashboard: templates', () => {
  it('offers the standard dashboards, each with its own grid', () => {
    for (const value of ['capacity', 'tier1', 'tags', 'reclaim', 'certs', 'host_health', 'vm_perf', 'datastore', 'nsx', 'vks', 'alerts', 'cost', 'compliance', 'home', 'custom']) {
      expect(TEMPLATES).toContain(value);
      const grid = DASHBOARD.inputs.find((i) => i.id === `widgets_${value}`);
      expect(grid?.showWhen?.equals).toEqual([value]);
      expect(tableShape(grid!)?.columns).toEqual(['Type', 'Title', 'Settings', 'Position', 'Provider', 'Receives from', 'Loaded widget']);
    }
  });

  it('builds every template with no errors and no warnings', () => {
    const problems: string[] = [];
    for (const template of TEMPLATES) {
      const out = DASHBOARD.build({ ...BASE, template }, 'test');
      for (const f of out.findings ?? []) if (f.severity !== 'info') problems.push(`${template}: ${f.severity} ${f.code}: ${f.message}`);
      const json = JSON.parse(out.files['import/dashboard.json']!) as DashboardJson;
      if (json.dashboards[0]!.widgets.length === 0) problems.push(`${template}: no widgets`);
    }
    expect(problems).toEqual([]);
  });

  it('points every template View widget at a view the view blueprint writes under the same name', () => {
    const viewTemplates = (VIEW.inputs.find((i) => i.id === 'template')?.options ?? []).map((o) => o.value).filter((v) => v !== 'custom');
    const written = new Set(viewTemplates.map((template) => /<ViewDef id="([^"]+)">/.exec(VIEW.build({ ...defaultValues(VIEW), template }, 'v').files['import/view.xml'] ?? '')?.[1]));
    for (const template of TEMPLATES) {
      const json = JSON.parse(DASHBOARD.build({ ...BASE, template }, 'test').files['import/dashboard.json']!) as DashboardJson;
      for (const widget of json.dashboards[0]!.widgets.filter((w) => w.type === 'View')) expect(written.has(String(widget.config['viewDefinitionId']))).toBe(true);
    }
  });
});

describe('vcfops_dashboard: the widget catalogue', () => {
  it('covers the VCF Operations 9 widget list', () => {
    const types = WIDGET_TYPES.map((t) => t.type);
    for (const type of ['ResourceList', 'View', 'Scoreboard', 'ScoreboardHealth', 'Heatmap', 'HealthChart', 'MetricChart', 'SparklineChart', 'ParetoAnalysis', 'AlertList', 'ProblemAlertsList', 'PropertyList', 'TextDisplay', 'RollingViewChart', 'MashupChart', 'ResourceRelationship', 'ResourceRelationshipAdvanced', 'TopologyGraph', 'Forensics', 'WeatherMap', 'Geo', 'IntSummaryCapacity', 'IntSummaryWorkload', 'IntSummaryRisk', 'IntSummaryEfficiency', 'IntSummaryHealth', 'IntSummaryAnomalies', 'RecommendedActions', 'TagPicker', 'MetricPicker', 'LogAnalysis', 'Skittles', 'Section']) {
      expect(types).toContain(type);
    }
    expect(new Set(types).size).toBe(types.length);
    for (const type of WIDGET_TYPES) expect(type.source.length).toBeGreaterThan(5);
    for (const type of WIDGET_TYPES.filter((t) => !t.verified)) expect(Boolean(type.note) || type.source.includes('no export')).toBe(true);
  });

  it('builds every catalogue type into a dashboard, with the config its type writes', () => {
    const rows = ['ResourceList | Driver | kinds=cluster | 1,1,4,6 | yes | '];
    for (const type of WIDGET_TYPES.filter((t) => t.type !== 'ResourceList')) {
      const receives = type.needsSubject ? 'Driver' : '';
      rows.push(`${type.type} | A ${type.label} | ${sampleSettings(type)} | auto | no | ${receives}`);
    }
    const { findings, json } = build(rows, { max_widgets: 100 });
    expect(errors(findings)).toEqual([]);
    const widgets = json.dashboards[0]!.widgets;
    expect(widgets.length).toBe(WIDGET_TYPES.length);
    for (const type of WIDGET_TYPES) {
      const widget = widgets.find((w) => w.type === type.type);
      expect(widget?.type).toBe(type.type);
      expect(typeof widget?.config).toBe('object');
    }
    // An unverified type says so, once per row.
    const unverified = findings.filter((f) => f.code === 'vcfops.dashboard.unverified-widget').length;
    expect(unverified).toBe(WIDGET_TYPES.filter((t) => !t.verified).length);
    // Every entries id a widget refers to is in the entries table.
    const text = JSON.stringify(json.dashboards[0]);
    const kinds = new Set(json.entries.resourceKind.map((k) => k.internalId));
    for (const ref of text.match(/resourceKind:id:\d+_::_/g) ?? []) expect(kinds.has(ref)).toBe(true);
    const resources = new Set(json.entries.resource.map((r) => r.internalId));
    for (const ref of text.match(/resource:id:\d+_::_/g) ?? []) expect(resources.has(ref)).toBe(true);
  });

  it('writes the verified shapes as the exports have them', () => {
    const { json } = build([
      'Scoreboard | Tiles | kind=cluster; metrics=cpu|usage_average,mem|usage_average; labels=CPU,Memory; thresholds=70,80,90; theme=gauge | 1,1,6,4 | yes | ',
      'Heatmap | Heat | kind=vm; groupby=host; sizeby=config|hardware|num_Cpu; colorby=cpu|usage_average | 7,1,6,4 | yes | ',
      'ParetoAnalysis | Top | kind=vm; metric=cpu|readyPct; top=5; order=lowest | 1,5,6,4 | yes | ',
      'HealthChart | Health | kind=host; metric=badge|risk; mode=self | 7,5,6,4 | no | Top',
      'TextDisplay | Html | html=<b>bold; and more</b> | 1,9,12,2 | no | ',
    ]);
    const w = (title: string) => json.dashboards[0]!.widgets.find((x) => x.title === title)!.config as Record<string, any>;
    const score = w('Tiles');
    expect(score['metric'].mode).toBe('resourceKind');
    expect(score['metric'].resourceKindMetrics.map((m: { metricKey: string }) => m.metricKey)).toEqual(['cpu|usage_average', 'mem|usage_average']);
    expect(score['metric'].resourceKindMetrics[0].colorMethod).toBe(0);
    expect(score['metric'].resourceKindMetrics[0].redBound).toBe(90);
    expect(score['metric'].resourceKindMetrics[1].label).toBe('Memory');
    expect(score['visualTheme']).toBe(9);
    expect(score['selfProvider']).toEqual({ selfProvider: true });
    const heat = w('Heat');
    expect(heat['configs'][0].groupBy.id).toBe('004null002006VMWAREHostSystem');
    expect(heat['configs'][0].sizeBy.metricKey).toBe('config|hardware|num_Cpu');
    expect(heat['relationshipMode']).toEqual({ relationshipMode: [1, -1, 0] });
    const top = w('Top');
    expect(top['barsCount']).toBe(5);
    expect(top['topOption']).toBe('metricsLowestUtilization');
    expect(top['metric']).toEqual({ metricKey: 'cpu|readyPct', name: 'cpu|readyPct' });
    const health = w('Health');
    expect(health['metricType']).toEqual({ metricType: 'risk' });
    expect(health['selfProvider']).toEqual({ selfProvider: false });
    expect(w('Html')['editorData']).toBe('<b>bold; and more</b>');
  });

  it('reads object types, settings and metric keys as the grid writes them', () => {
    expect(parseKind('cluster')).toEqual({ adapterKind: 'VMWARE', resourceKind: 'ClusterComputeResource' });
    expect(parseKind('NSXTAdapter/TransportNode')).toEqual({ adapterKind: 'NSXTAdapter', resourceKind: 'TransportNode' });
    expect(parseKind('Datastore')).toEqual({ adapterKind: 'VMWARE', resourceKind: 'Datastore' });
    const s = new Settings('kind=vm; metrics=cpu|usage_average, Super Metric|sm_1; text=a; b=c');
    expect(s.list('metrics')).toEqual(['cpu|usage_average', 'Super Metric|sm_1']);
    expect(s.get('text')).toBe('a; b=c');
    expect(metricKeyProblem('cpu|usage_average')).toBeUndefined();
    expect(metricKeyProblem('net:physical|droppedPct')).toBeUndefined();
    expect(metricKeyProblem('Super Metric|sm_a4547391-d436-47b2-9fee-acf4f16a386a')).toBeUndefined();
    expect(metricKeyProblem('cpu||usage')).toBeDefined();
    expect(metricKeyProblem('cpu | usage')).toBeDefined();
    expect(metricKeyProblem('cpu usage')).toBeDefined();
    expect(metricKeyProblem('|cpu')).toBeDefined();
  });
});

describe('vcfops_dashboard: layout', () => {
  it('flow-packs automatic widgets into the 12 columns without overlaps', () => {
    const sizes = ['4,6', '8,3', '3,3', '12,2', '6,4', '5,5', '7,2', '2,2', 'auto', 'auto', '9,3', '3,6'];
    const rows = parseWidgetRows(['ResourceList | Fixed | kinds=vm | 5,2,4,4 | yes | ', ...sizes.map((size, i) => `TextDisplay | T${i} | text=x | ${size} | no | `)].join('\n'));
    const { placed, problems } = layoutWidgets(rows);
    expect(problems).toEqual([]);
    expect(placed.length).toBe(rows.length);
    expect(placed[0]).toEqual({ ...placed[0]!, x: 5, y: 2, w: 4, h: 4 });
    for (const a of placed) {
      expect(a.x).toBeGreaterThanOrEqual(1);
      expect(a.x + a.w - 1).toBeLessThanOrEqual(12);
      for (const b of placed) {
        if (a === b) continue;
        expect(a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h).toBe(false);
      }
    }
    // The first gap: a 4-wide widget fits left of the fixed one, at the top.
    expect(placed[1]).toEqual({ ...placed[1]!, x: 1, y: 1 });
  });

  it('builds the automatic layout with no overlap error, and makes a Section full width and holds the widgets below it', () => {
    const { findings, json } = build([
      'Section | Capacity | | 1,1,4,3 | no | ',
      'ResourceList | Clusters | kinds=cluster | auto | yes | ',
      'Scoreboard | Remaining | kind=cluster; metrics=OnlineCapacityAnalytics|timeRemaining | auto | no | Clusters',
      'Section | Performance | | 1,20,12,1 | no | ',
      'MetricChart | CPU | kind=cluster; metrics=cpu|usage_average | 1,21,12,4 | no | Clusters',
    ]);
    expect(errors(findings)).toEqual([]);
    const widgets = json.dashboards[0]!.widgets;
    const section = widgets.find((w) => w.title === 'Capacity')!;
    expect(section.gridsterCoords).toEqual({ x: 1, y: 1, w: 12, h: 1 });
    const id = (title: string) => widgets.find((w) => w.title === title)!.id;
    expect(section.config['widgets']).toEqual([id('Clusters'), id('Remaining')]);
    expect(widgets.find((w) => w.title === 'Performance')!.config['widgets']).toEqual([id('CPU')]);
  });
});

describe('vcfops_dashboard: interactions', () => {
  it('wires each "Receives from" as a widget interaction, and a Metric Picker as metricId', () => {
    const { json } = build(undefined, { template: 'tier1' });
    const dash = json.dashboards[0]!;
    const id = (title: string) => dash.widgets.find((w) => w.title === title)!.id;
    const receivers = dash.widgetInteractions.filter((i) => i.widgetIdProvider === id('Tier 1 VMs')).map((i) => i.widgetIdReceiver).sort();
    expect(receivers).toEqual([id('Health, last 24 hours'), id('Right now'), id('Top alerts'), id('Tier 1 detail')].sort());
    expect(dash.widgetInteractions.every((i) => i.type === 'resourceId')).toBe(true);
    // The provider provides for itself; the receivers wait to be sent an object.
    expect(dash.widgets.find((w) => w.title === 'Tier 1 VMs')!.config['selfProvider']).toEqual({ selfProvider: true });
    expect(dash.widgets.find((w) => w.title === 'Right now')!.config['selfProvider']).toEqual({ selfProvider: false });

    const alerts = build(undefined, { template: 'alerts' }).json.dashboards[0]!;
    const aid = (title: string) => alerts.widgets.find((w) => w.title === title)!.id;
    expect(alerts.widgetInteractions.find((i) => i.widgetIdReceiver === aid('Its metrics'))).toEqual({ type: 'resourceId', widgetIdProvider: aid('Object behind the alert'), widgetIdReceiver: aid('Its metrics') });
    const picked = build([
      'ResourceList | VMs | kinds=vm | 1,1,4,6 | yes | ',
      'MetricPicker | Metrics | | 5,1,4,6 | no | VMs',
      'MetricChart | Chart | kind=vm; metrics=cpu|usage_average | 9,1,4,6 | no | Metrics',
    ]).json.dashboards[0]!;
    expect(picked.widgetInteractions.map((i) => i.type)).toEqual(['resourceId', 'metricId']);
  });
});

describe('vcfops_dashboard: every check on the grid', () => {
  const cases: { name: string; rows: string[]; code: string; extra?: BlueprintValues }[] = [
    { name: 'an unknown type', rows: ['Speedometer | Speed | | auto | yes | '], code: 'vcfops.dashboard.unknown-type' },
    { name: 'a missing required setting', rows: ['Scoreboard | Tiles | kind=vm | auto | yes | '], code: 'vcfops.dashboard.bad-setting' },
    { name: 'a bad metric key', rows: ['MetricChart | Chart | kind=vm; metrics=cpu||usage | auto | yes | '], code: 'vcfops.dashboard.bad-setting' },
    { name: 'a value not in the list', rows: ['ParetoAnalysis | Top | kind=vm; metric=cpu|readyPct; order=sideways | auto | yes | '], code: 'vcfops.dashboard.bad-setting' },
    { name: 'thresholds out of order', rows: ['Scoreboard | Tiles | kind=vm; metrics=cpu|readyPct; thresholds=5,1,9 | auto | yes | '], code: 'vcfops.dashboard.bad-setting' },
    { name: 'a bad object type', rows: ['ResourceList | List | kinds=Adapter/ | auto | yes | '], code: 'vcfops.dashboard.bad-setting' },
    { name: 'overlapping widgets', rows: ['ResourceList | A | kinds=vm | 1,1,6,4 | yes | ', 'ResourceList | B | kinds=host | 4,2,6,4 | yes | '], code: 'vcfops.dashboard.overlap' },
    { name: 'a widget off the grid', rows: ['ResourceList | Wide | kinds=vm | 9,1,6,4 | yes | '], code: 'vcfops.dashboard.off-grid' },
    { name: 'an automatic widget wider than the grid', rows: ['ResourceList | Wide | kinds=vm | 14,4 | yes | '], code: 'vcfops.dashboard.bad-position' },
    { name: 'a position that is not one', rows: ['ResourceList | List | kinds=vm | top left | yes | '], code: 'vcfops.dashboard.bad-position' },
    { name: 'a receiver naming no widget', rows: ['ResourceList | List | kinds=vm | auto | yes | ', 'MetricChart | Chart | kind=vm; metrics=cpu|usage_average | auto | no | Nowhere'], code: 'vcfops.dashboard.unknown-sender' },
    { name: 'a sender that cannot send', rows: ['Scoreboard | Tiles | kind=vm; metrics=cpu|readyPct | auto | yes | ', 'MetricChart | Chart | kind=vm; metrics=cpu|usage_average | auto | no | Tiles'], code: 'vcfops.dashboard.sender-cannot-provide' },
    {
      name: 'a loop of interactions',
      rows: ['ResourceList | A | kinds=vm | auto | no | C', 'ResourceList | B | kinds=vm | auto | no | A', 'ResourceList | C | kinds=vm | auto | no | B'],
      code: 'vcfops.dashboard.interaction-cycle',
    },
    { name: 'a widget receiving from itself', rows: ['ResourceList | A | kinds=vm | auto | no | A'], code: 'vcfops.dashboard.interaction-cycle' },
    { name: 'a self-provider that also receives', rows: ['ResourceList | A | kinds=vm | auto | yes | ', 'View | B | view=Reclamation | auto | yes | A'], code: 'vcfops.dashboard.provider-receives' },
    { name: 'two widgets with one title', rows: ['ResourceList | A | kinds=vm | auto | yes | ', 'ResourceList | A | kinds=host | auto | yes | '], code: 'vcfops.dashboard.duplicate-title' },
    { name: 'a widget with no title', rows: ['ResourceList |  | kinds=vm | auto | yes | '], code: 'vcfops.dashboard.no-title' },
    { name: 'a provider that is not yes or no', rows: ['ResourceList | A | kinds=vm | auto | maybe | '], code: 'vcfops.dashboard.bad-provider' },
    { name: 'an empty grid', rows: ['# nothing'], code: 'vcfops.dashboard.no-widgets' },
    { name: 'a navigation from no widget', rows: ['ResourceList | A | kinds=vm | auto | yes | '], code: 'vcfops.dashboard.bad-navigation', extra: { navigations: 'Nowhere -> ESX host health' } },
    { name: 'sharing with no group named', rows: ['ResourceList | A | kinds=vm | auto | yes | '], code: 'vcfops.dashboard.no-groups', extra: { sharing: 'groups', share_groups: '' } },
  ];
  for (const c of cases) {
    it(`refuses ${c.name}`, () => {
      expect(codes(build(c.rows, c.extra).findings)).toContain(c.code);
    });
  }

  it('warns, rather than refuses, for a widget that opens empty and for an unverified type', () => {
    const { findings } = build(['MetricChart | Chart | kind=vm; metrics=cpu|usage_average | auto | no | ', 'WeatherMap | Weather | kind=vm; metric=cpu|usage_average | auto | yes | ']);
    expect(errors(findings)).toEqual([]);
    const warned = findings.filter((f) => f.severity === 'warning').map((f) => f.code);
    expect(warned).toContain('vcfops.dashboard.no-subject');
    expect(warned).toContain('vcfops.dashboard.unverified-widget');
    expect(warned).toContain('vcfops.dashboard.deprecated-widget');
  });
});

describe('vcfops_dashboard: dashboard options', () => {
  it('writes folder, description, home tab, lock, autoswitch, time range, navigations and group sharing', () => {
    const { files, json, findings } = build(['ResourceList | Clusters | kinds=cluster | 1,1,4,6 | yes | '], {
      dashboard_name: 'Capacity',
      folder: 'Platform/Capacity',
      description: 'For the platform team',
      home_tab: true,
      locked: true,
      autoswitch: true,
      autoswitch_delay: 60,
      time_range: 'last7Days',
      sharing: 'groups',
      share_groups: "Platform Ops, Ops Team's@VIDM",
      navigations: 'Clusters -> ESX host health',
    });
    expect(errors(findings)).toEqual([]);
    const dash = json.dashboards[0]! as DashboardJson['dashboards'][number] & Record<string, unknown>;
    expect(dash.name).toBe('Platform/Capacity/Capacity');
    expect(dash.namePath).toBe('Platform/Capacity');
    expect(dash['description']).toBe('For the platform team');
    expect(dash.homeTab).toBe(true);
    expect(dash.locked).toBe(true);
    expect(dash.autoswitchEnabled).toBe(true);
    expect(dash['autoswitchDelay']).toBe(60);
    expect(dash.states[0]?.key).toBe(`permDashboardTime_dashboard_${dash.id}`);
    expect(dash.states[0]?.value.includes('last7Days')).toBe(true);
    const from = dash.widgets.find((w) => w.title === 'Clusters')!.id;
    expect(dash.dashboardNavigations[from]).toEqual([{ id: stableId('dashboard:ESX host health'), widgets: [] }]);
    const script = files['import-dashboard.sh']!;
    expect(script.includes('groupName: "Platform Ops", sourceType: "LOCAL"')).toBe(true);
    expect(script.includes(`groupName: "Ops Team'\\''s", sourceType: "VIDM"`)).toBe(true);
    expect(script.includes('groupName: "Everyone"')).toBe(false);
    expect(findings.some((f) => f.code === 'vcfops.dashboard.group-source')).toBe(true);
  });

  it('keeps a private dashboard private and a shared one shared with Everyone', () => {
    const priv = build(undefined, { template: 'capacity', sharing: 'private' });
    expect(priv.json.dashboards[0]!.shared).toBe(false);
    expect(priv.files['import-dashboard.sh']!.includes('rmdir "$WORK/content/dashboardsharings"')).toBe(true);
    const everyone = build(undefined, { template: 'capacity' });
    expect(everyone.json.dashboards[0]!.shared).toBe(true);
    expect(everyone.files['import-dashboard.sh']!.includes('groupName: "Everyone"')).toBe(true);
  });

  it('applies a row refresh over the dashboard default, and refresh=off turns refreshing off', () => {
    const { json } = build(['ResourceList | A | kinds=vm; refresh=60 | auto | yes | ', 'ResourceList | B | kinds=vm; refresh=off | auto | yes | '], { refresh: '600' });
    const [a, b] = json.dashboards[0]!.widgets;
    expect(a!.config['refreshInterval']).toBe(60);
    expect(b!.config['refreshInterval']).toBe(600);
    expect(b!.config['refreshContent']).toEqual({ refreshContent: false });
  });
});

describe('vcfops_dashboard: reads back on the VCF Ops content page', () => {
  it('reads every template’s dashboard.zip back with its widget count and types', async () => {
    for (const template of TEMPLATES) {
      const out = DASHBOARD.build({ ...BASE, template }, 'test');
      const json = JSON.parse(out.files['import/dashboard.json']!) as DashboardJson;
      const archive = await fromArchive({ ...out.files }, 'import/dashboard.zip');
      const content = await readAriaFile('dashboard.zip', archive);
      expect(content.dashboards.length).toBe(1);
      const read = content.dashboards[0]!;
      expect(read.name).toBe(json.dashboards[0]!.name);
      expect(read.widgets.length).toBe(json.dashboards[0]!.widgets.length);
      expect(read.widgets.map((w) => w.type)).toEqual(json.dashboards[0]!.widgets.map((w) => w.type));
      expect(read.widgets.map((w) => [w.x, w.y, w.w, w.h])).toEqual(json.dashboards[0]!.widgets.map((w) => [w.gridsterCoords.x, w.gridsterCoords.y, w.gridsterCoords.w, w.gridsterCoords.h]));
    }
  });

  it('reads the default dashboard back with its view, and the bare JSON too', async () => {
    const out = DASHBOARD.build(BASE, 'test');
    const content = await readAriaFile('dashboard.json', new TextEncoder().encode(out.files['import/dashboard.json']!));
    expect(content.dashboards[0]?.name).toBe('Cluster capacity overview');
    expect(content.dashboards[0]?.viewIds).toEqual([stableId('view:Cluster capacity overview')]);
    expect(content.dashboards[0]?.widgets.map((w) => w.type)).toEqual(['TextDisplay', 'ResourceList', 'Scoreboard', 'ParetoAnalysis', 'View', 'Heatmap', 'HealthChart']);
  });
});

describe('the grid editor reads a declared grid', () => {
  it('splits a declared grid only on " | ", so metric keys keep their pipes', () => {
    const grid = DASHBOARD.inputs.find((i) => i.id === 'widgets_capacity')!;
    const shape = tableShape(grid)!;
    expect(shape.spaced).toBe(true);
    expect(shape.choices?.[0]?.map((o) => o.value)).toEqual(WIDGET_TYPES.map((t) => t.type));
    expect(shape.choices?.[4]?.map((o) => o.value)).toEqual(['yes', 'no']);
    expect(shape.choices?.[1]).toBeUndefined();
    // A textarea without options is read as before.
    expect(tableShape({ id: 'x', label: 'x', control: 'textarea', default: 'a | b', hint: 'A | B' })?.spaced).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Loading a dashboard from an export, editing it, and writing it back
// ---------------------------------------------------------------------------

/**
 * A content export shaped like a real one (a live 9.x appliance's Content
 * Management export, read for its shapes: keys only, no customer values): one
 * zip per dashboard under dashboards/<owner>, an entries table with an
 * adapterKind table beside resourceKind and resource, per-widget states,
 * widget x/y/height beside gridsterCoords, a widget type the catalogue lacks
 * (FutureWidget), a Tag Picker wired by tagId, a receiver with two senders,
 * repeated titles, a title holding " | ", a stale navigation, a collapsed
 * widget overlapping another, and dashboard keys the builder never writes
 * (docCenterKey, entryKeys, adapterName).
 */
function realShapedDashboard(id: string, name: string): Record<string, unknown> {
  const w = (suffix: string) => `${id}-${suffix}`;
  return {
    shared: true,
    temporary: false,
    hidden: false,
    creationTime: 1718000000000,
    autoswitchEnabled: false,
    importAttempts: 0,
    columnProportion: '1',
    importComplete: true,
    columnCount: 1,
    userId: 'a1b2c3d4-0000-4000-8000-000000000001',
    states: [{ key: `permDashboardTime_dashboard_${id}`, value: 'o%3AdateRange%3Ds%253Alast24Hour%5EdateRangeText%3Ds%253A24H' }],
    homeTab: false,
    name,
    gridsterMaxColumns: 12,
    rank: 4,
    disabled: false,
    id,
    locked: false,
    lastUpdateUserId: 'a1b2c3d4-0000-4000-8000-000000000001',
    lastUpdateTime: 1718000500000,
    description: 'VMs by tag, with their load',
    adapterName: null,
    namePath: 'Operations',
    docCenterKey: '',
    entryKeys: [],
    dashboardNavigations: { [w('list')]: [{ id: 'ffffffff-0000-4000-8000-00000000abcd', widgets: [{ interactionType: 'resourceId', id: 'eeeeeeee-0000-4000-8000-000000000001' }] }], 'no-such-widget': [] },
    widgetInteractions: [
      { type: 'tagId', widgetIdProvider: w('tags'), widgetIdReceiver: w('list') },
      { type: 'resourceId', widgetIdProvider: w('list'), widgetIdReceiver: w('chart') },
      { type: 'resourceId', widgetIdProvider: w('list2'), widgetIdReceiver: w('chart') },
      { type: 'resourceId', widgetIdProvider: w('list'), widgetIdReceiver: w('pareto') },
    ],
    widgets: [
      { collapsed: false, id: w('tags'), gridsterCoords: { w: 3, x: 1, h: 8, y: 1 }, type: 'TagPicker', title: 'Tags', config: { refreshInterval: 300, refreshContent: { refreshContent: true } }, states: [{ key: 'expanded', value: 'b%3A1' }] },
      {
        collapsed: false,
        x: 4,
        y: 1,
        id: w('list'),
        gridsterCoords: { w: 5, x: 4, h: 8, y: 1 },
        type: 'ResourceList',
        title: 'VMs | by tag',
        height: 300,
        config: {
          refreshInterval: 300,
          resource: [],
          refreshContent: { refreshContent: true },
          relationshipMode: { relationshipMode: 0 },
          additionalColumns: [{ boxLabel: 'CPU', metricKey: 'cpu|usage_average', metricName: 'CPU Usage (%)', resourceKindId: 'resourceKind:id:1_::_', metricUnitId: 'percent' }],
          selfProvider: { selfProvider: false },
          title: 'VMs | by tag',
          mode: 'all',
          filterMode: 'tagPicker',
          tagFilter: { path: ['/source/kind/kind:resourceKind:id:1_::_'], value: { kind: ['resourceKind:id:1_::_'], tag: [] } },
          depth: 1,
          customFilter: { filter: [], excludedResources: null, includedResources: null },
          selectFirstRow: { selectFirstRow: true },
          pageSize: 50,
        },
      },
      {
        collapsed: false,
        id: w('list2'),
        gridsterCoords: { w: 4, x: 9, h: 8, y: 1 },
        type: 'ResourceList',
        title: 'Hosts',
        config: { refreshInterval: 300, refreshContent: { refreshContent: true }, selfProvider: { selfProvider: true }, title: 'Hosts', mode: 'all', filterMode: 'tagPicker', tagFilter: { path: ['/source/kind/kind:resourceKind:id:0_::_'], value: { kind: ['resourceKind:id:0_::_'] } }, depth: 1 },
      },
      {
        collapsed: false,
        id: w('chart'),
        gridsterCoords: { w: 6, x: 1, h: 6, y: 9 },
        type: 'MetricChart',
        title: 'Hosts',
        config: {
          refreshInterval: 300,
          refreshContent: { refreshContent: true },
          selfProvider: { selfProvider: false },
          title: 'Hosts',
          metric: { mode: 'resourceKind', resourceMetrics: [], subMode: 'resourceKindAll', resourceKindMetrics: [{ metricKey: 'cpu|usage_average', resourceKindId: 'resourceKind:id:1_::_', label: 'CPU', colorMethod: 2, id: 'extModel1-1' }] },
          relationshipMode: { relationshipMode: 0 },
          chartType: 'area',
        },
      },
      { collapsed: false, id: w('pareto'), gridsterCoords: { w: 6, x: 7, h: 6, y: 9 }, type: 'FutureWidget', title: '', config: { barsCount: 10, metricKey: 'mem|usage_average', whatever: { nested: [1, 2, 3] } } },
      { collapsed: true, id: w('folded'), gridsterCoords: { w: 6, x: 7, h: 1, y: 9 }, type: 'View', title: 'Folded view', config: { viewDefinitionId: '0f8b2b9c-3a1e-4b7a-9c2d-1e2f3a4b5c6d', refreshInterval: 300, selfProvider: { selfProvider: false }, title: 'Folded view', traversalSpecId: 'vSphere Hosts and Clusters-VMWARE-vSphere World' } },
    ],
  };
}

function realShapedExport(id: string, name: string): string {
  return JSON.stringify({
    entries: {
      resourceKind: [
        { resourceKindKey: 'HostSystem', internalId: 'resourceKind:id:0_::_', adapterKindKey: 'VMWARE' },
        { resourceKindKey: 'VirtualMachine', internalId: 'resourceKind:id:1_::_', adapterKindKey: 'VMWARE' },
      ],
      adapterKind: [{ internalId: 'adapterKind:id:0_::_', adapterKindKey: 'VMWARE' }],
      resource: [],
    },
    dashboards: [realShapedDashboard(id, name)],
    uuid: `9d0c1e2f-0000-4000-8000-${id.slice(-12)}`,
  });
}

const ID_A = '11111111-2222-4333-8444-555555555555';
const ID_B = '11111111-2222-4333-8444-666666666666';

async function contentPackageZip(): Promise<Uint8Array> {
  const one = await zip({ 'dashboard/dashboard.json': realShapedExport(ID_A, 'Operations/VM tags') });
  const two = await zip({ 'dashboard/dashboard.json': realShapedExport(ID_B, 'Operations/Host tags') });
  // A content export: one zip per dashboard owner under dashboards/, beside the other content.
  return zip({ 'dashboards/a1b2c3d4-0000-4000-8000-000000000001': one, 'dashboards/a1b2c3d4-0000-4000-8000-000000000002': two, 'supermetrics.json': '{}', 'customgroups.json': '{"customGroups":[]}' });
}

describe('vcfops_dashboard: loading an export to edit', () => {
  it('finds every dashboard in a content export and offers them to pick', async () => {
    const exports = await readDashboardExports('content.zip', await contentPackageZip());
    const choices = dashboardChoices(exports);
    expect(choices.map((c) => c.name)).toEqual(['Operations/VM tags', 'Operations/Host tags']);
    expect(choices.map((c) => c.widgets)).toEqual([6, 6]);
  });

  it('loads, generates with no edits, and writes the dashboard back exactly as exported', async () => {
    const exports = await readDashboardExports('content.zip', await contentPackageZip());
    const original = JSON.parse(realShapedExport(ID_B, 'Operations/Host tags')) as Record<string, unknown>;
    const loaded = loadDashboard(exports[1]!, 0, exports);
    // What the builder shows: a row for every widget, titles made unique and single-line.
    const rows = String(loaded.values['widgets_custom']).split('\n');
    expect(rows.length).toBe(6);
    expect(rows[1]!.startsWith('ResourceList | VMs|by tag | kinds=vm; columns=cpu|usage_average; columnlabels=CPU | 4,1,5,8 | no | Tags | ')).toBe(true);
    expect(rows[3]!.split(' | ').slice(0, 2)).toEqual(['MetricChart', 'Hosts (2)']);
    expect(rows[4]!.split(' | ')[0]).toBe('FutureWidget');
    expect(loaded.values['dashboard_name']).toBe('Host tags');
    expect(loaded.values['folder']).toBe('Operations');
    expect(loaded.values['time_range']).toBe('last24Hour');
    // Flagged: the unknown type, the second sender, the navigation known only by id.
    expect((loaded.store.kept[`${ID_B}-pareto`] ?? []).some((k) => k.includes('does not know'))).toBe(true);
    expect(loaded.store.notes.some((n) => n.includes('beyond one sender'))).toBe(true);
    expect(loaded.store.notes.some((n) => n.includes('navigation'))).toBe(true);

    const out = DASHBOARD.build({ ...BASE, ...loaded.values }, 'test');
    expect(errors(out.findings ?? [])).toEqual([]);
    const json = JSON.parse(out.files['import/dashboard.json']!) as Record<string, unknown>;
    expect(json['dashboards']).toEqual(original['dashboards']);
    expect(json['entries']).toEqual(original['entries']);
    expect(json['uuid']).toBe(original['uuid']);
    // The zip the content page reads holds the same.
    const zipped = await readAriaFile('dashboard.zip', await fromArchive({ ...out.files }, 'import/dashboard.zip'));
    expect(zipped.dashboards[0]?.widgets.length).toBe(6);
  });

  it('applies an edit to what it changes and keeps everything else as exported', async () => {
    const exports = await readDashboardExports('content.zip', await contentPackageZip());
    const loaded = loadDashboard(exports[0]!, 0, exports);
    const original = realShapedDashboard(ID_A, 'Operations/VM tags') as { widgets: Record<string, any>[]; widgetInteractions: unknown[]; dashboardNavigations: Record<string, unknown> };
    const rows = String(loaded.values['widgets_custom']).split('\n');
    // Add a column to the Object List, move the chart, and remove the unknown widget.
    rows[1] = rows[1]!.replace('columns=cpu|usage_average', 'columns=cpu|usage_average,mem|usage_average');
    rows[3] = rows[3]!.replace('1,9,6,6', '1,15,6,6');
    rows.splice(4, 1);
    const out = DASHBOARD.build({ ...BASE, ...loaded.values, widgets_custom: rows.join('\n') }, 'test');
    const dash = (JSON.parse(out.files['import/dashboard.json']!) as { dashboards: { widgets: Record<string, any>[]; widgetInteractions: unknown[]; dashboardNavigations: Record<string, unknown> }[] }).dashboards[0]!;
    const list = dash.widgets[1]!;
    expect(list['config'].additionalColumns.map((c: { metricKey: string }) => c.metricKey)).toEqual(['cpu|usage_average', 'mem|usage_average']);
    // Keys the builder does not write are still there, and so is the exported title.
    expect(list['height']).toBe(300);
    expect(list['title']).toBe('VMs | by tag');
    for (const key of Object.keys(original.widgets[1]!['config'])) if (key !== 'additionalColumns') expect(list['config'][key]).toEqual(original.widgets[1]!['config'][key]);
    // The chart moved and nothing else about it changed.
    expect(dash.widgets[3]!['gridsterCoords']).toEqual({ x: 1, y: 15, w: 6, h: 6 });
    expect(dash.widgets[3]!['config']).toEqual(original.widgets[3]!['config']);
    // The removed widget took its interaction with it; the rest are as they were, and so are the navigations.
    expect(dash.widgets.length).toBe(5);
    expect(dash.widgetInteractions).toEqual(original.widgetInteractions.slice(0, 3));
    expect(dash.dashboardNavigations).toEqual(original.dashboardNavigations);
  });

  it('reads back the file this builder generates, and generates the same dashboard from it', async () => {
    for (const template of ['capacity', 'tier1', 'alerts', 'home', 'nsx']) {
      const first = DASHBOARD.build({ ...BASE, template }, 'test');
      // The .zip the page downloads: every file, import/dashboard.zip nested inside.
      const exports = await readDashboardExports('bundle.zip', await zip({ ...first.files }));
      const choices = dashboardChoices(exports);
      expect(choices.length).toBe(1);
      const loaded = loadDashboard(exports[choices[0]!.exportIndex]!, choices[0]!.dashboardIndex, exports);
      // Its own output reads back into rows the catalogue fully understands.
      expect(Object.values(loaded.store.kept).flat().filter((k) => k.startsWith('config keys'))).toEqual([]);
      const again = DASHBOARD.build({ ...BASE, ...loaded.values }, 'test');
      expect(JSON.parse(again.files['import/dashboard.json']!)).toEqual(JSON.parse(first.files['import/dashboard.json']!));
      expect(errors(again.findings ?? [])).toEqual([]);
    }
  });

  it('takes a bare dashboard .json holding several dashboards', async () => {
    const one = JSON.parse(realShapedExport(ID_A, 'A')) as { dashboards: unknown[] };
    const two = JSON.parse(realShapedExport(ID_B, 'B')) as { dashboards: unknown[] };
    const both = { ...one, dashboards: [...one.dashboards, ...two.dashboards] };
    const exports = await readDashboardExports('two.json', new TextEncoder().encode(JSON.stringify(both)));
    expect(dashboardChoices(exports).map((c) => c.name)).toEqual(['A', 'B']);
    const loaded = loadDashboard(exports[0]!, 1, exports);
    const out = DASHBOARD.build({ ...BASE, ...loaded.values }, 'test');
    expect((JSON.parse(out.files['import/dashboard.json']!) as { dashboards: unknown[] }).dashboards).toEqual([two.dashboards[0]]);
  });

  it('leaves a loaded dashboard alone once another template is chosen', async () => {
    const exports = await readDashboardExports('content.zip', await contentPackageZip());
    const loaded = loadDashboard(exports[0]!, 0, exports);
    const out = DASHBOARD.build({ ...BASE, ...loaded.values, template: 'capacity' }, 'test');
    const dash = (JSON.parse(out.files['import/dashboard.json']!) as DashboardJson).dashboards[0]!;
    expect(dash.widgets.map((w) => w.title)).toEqual(['About this dashboard', 'Clusters', 'Capacity remaining', 'Least time remaining', 'Cluster capacity', 'CPU demand by cluster', 'CPU demand trend']);
    expect(dash.id).toBe(stableId('dashboard:VM tags'));
  });
});

describe('the dashboard builder rows', () => {
  it('splits and joins rows without changing them, the loaded widget id included', () => {
    const text = ['# a comment', 'ResourceList | VMs | kinds=vm; columns=cpu|usage_average | 1,1,4,6 | yes | ', 'FutureWidget | Odd |  | 5,1,4,6 | no | VMs | 1234-abcd'].join('\n');
    const { rows, comments } = builderRows.splitRows(text);
    expect(rows.length).toBe(2);
    expect(rows[1]!.source).toBe('1234-abcd');
    expect(builderRows.joinRows(rows, comments)).toBe(text);
    const settings = builderRows.readSettings('kind=vm; text=a; b=c');
    expect(builderRows.writeSettings(settings.pairs, settings.malformed)).toBe('kind=vm; text=a; b=c');
  });
});

describe('vcfops_dashboard: what goes beside the dashboard', () => {
  it('lays the dashboard zip out as a dashboard export does, with the resources files', () => {
    const { files } = build(undefined, { template: 'capacity' });
    expect(Object.keys(files).filter((f) => f.startsWith('import/dashboard.zip/')).sort()).toEqual(
      ['dashboard/dashboard.json', ...['', '_de', '_es', '_fr', '_ja', '_ko', '_zh_cn', '_zh_tw'].map((l) => `dashboard/resources/resources${l}.properties`)].map((f) => `import/dashboard.zip/${f}`).sort(),
    );
    expect(files['IMPORT-ORDER.md']!.indexOf('## 1. Views')).toBeLessThan(files['IMPORT-ORDER.md']!.indexOf('## 3. The dashboard'));
  });

  it('bundles the template views it shows, and names any other view to import separately', () => {
    const own = build(undefined, { template: 'capacity' });
    const xml = own.files['import/views.zip/content.xml']!;
    expect(xml.includes(`<ViewDef id="${stableId('view:Cluster capacity overview')}">`)).toBe(true);
    expect(own.findings.some((f) => f.code === 'vcfops.dashboard.view-separate')).toBe(false);
    const other = build(['View | Someone’s view | view=0f8b2b9c-3a1e-4b7a-9c2d-1e2f3a4b5c6d | auto | yes | ', 'MetricChart | SM | kind=vm; metrics=Super Metric|sm_0f8b2b9c-3a1e-4b7a-9c2d-1e2f3a4b5c6d | auto | no | Someone’s view']);
    expect(other.findings.filter((f) => f.code === 'vcfops.dashboard.view-separate').length).toBe(1);
    expect(other.findings.some((f) => f.code === 'vcfops.dashboard.super-metrics')).toBe(true);
    expect(other.files['import/views.zip/content.xml']).toBeUndefined();
    expect(other.files['IMPORT-ORDER.md']!.includes('view id 0f8b2b9c-3a1e-4b7a-9c2d-1e2f3a4b5c6d')).toBe(true);
    expect(build(undefined, { template: 'capacity', include_views: false }).files['import/views.zip/content.xml']).toBeUndefined();
  });

  it('keeps the views a loaded content export held and writes them back', async () => {
    const viewId = '0f8b2b9c-3a1e-4b7a-9c2d-1e2f3a4b5c6d';
    const viewXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Content>\n    <Views>\n        <ViewDef id="${viewId}">\n            <Title>Folded</Title>\n        </ViewDef>\n        <ViewDef id="11111111-0000-4000-8000-000000000000">\n            <Title>Unused</Title>\n        </ViewDef>\n    </Views>\n</Content>\n`;
    const one = await zip({ 'dashboard/dashboard.json': realShapedExport(ID_A, 'Operations/VM tags') });
    const content = await zip({ 'dashboards/a1b2c3d4-0000-4000-8000-000000000001': one, 'views.zip': await zip({ 'content.xml': viewXml }) });
    const exports = await readDashboardExports('content.zip', content);
    const loaded = loadDashboard(exports[0]!, 0, exports, await readViewDefs(content));
    expect(Object.keys(loaded.store.views ?? {})).toEqual([viewId]);
    const out = DASHBOARD.build({ ...BASE, ...loaded.values }, 'test');
    const written = out.files['import/views.zip/content.xml']!;
    expect(written.includes(`<ViewDef id="${viewId}">`)).toBe(true);
    expect(written.includes('Unused')).toBe(false);
  });

  it('writes and reads back the dashboard-level options: hidden, disabled, column split, every time range', async () => {
    for (const time_range of ['lastHour', 'last30Days', 'last90Days', 'lastYear']) {
      const first = DASHBOARD.build({ ...BASE, template: 'capacity', hidden: true, disabled: true, column_proportion: '1-1', time_range }, 'test');
      const dash = (JSON.parse(first.files['import/dashboard.json']!) as { dashboards: Record<string, unknown>[] }).dashboards[0]!;
      expect([dash['hidden'], dash['disabled'], dash['columnProportion']]).toEqual([true, true, '1-1']);
      const exports = await readDashboardExports('bundle.zip', await zip({ ...first.files }));
      const loaded = loadDashboard(exports[0]!, 0, exports);
      expect([loaded.values['hidden'], loaded.values['disabled'], loaded.values['column_proportion'], loaded.values['time_range']]).toEqual([true, true, '1-1', time_range]);
    }
  });
});
