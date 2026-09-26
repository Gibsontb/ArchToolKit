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
import { readAriaFile } from '../aria/parse.ts';
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
      expect(tableShape(grid!)?.columns).toEqual(['Type', 'Title', 'Settings', 'Position', 'Provider', 'Receives from']);
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
