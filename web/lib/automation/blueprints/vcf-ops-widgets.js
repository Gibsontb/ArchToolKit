/**
 * Every widget VCF Operations 9 offers in a dashboard's widget list, with the
 * config a dashboard export carries for it.
 *
 * A widget in an export is `{id, type, title, collapsed, gridsterCoords,
 * config}`; everything that makes one Scoreboard different from another is in
 * `config`, and the keys there differ from type to type — `metric.
 * resourceKindMetrics[]` on a Scoreboard, a flat `metricKey` on a Health Chart,
 * `configs[]` tabs on a Heatmap, `barsCount` and `topOption` on a Top-N. A key
 * the widget does not know is ignored; a key it needs and does not find leaves
 * it unconfigured. So the shapes here are copied from real exports, and each
 * says where from.
 *
 * Where the shapes come from (fetched 2026-09, the repos cloned and every
 * dashboard.json in them read, zips inside zips included — 227 dashboards):
 *
 *   CF     github.com/sentania-labs/vcf-content-factory,
 *          src/vcfcf_core/dashboards/render.py — a VCF Operations 9 dashboard
 *          renderer whose output is imported and checked on live 9.x instances,
 *          with knowledge/context/api-surface/widget_types_survey.md (a live
 *          9.x export: 231 dashboards, 2,019 widgets, every type counted).
 *   QA92   the same repo, reference/docs/extracted/dashboard-widgets/
 *          qa-9.2.0-export-alertvolume-section-viewdetails.json (a 9.2 export)
 *          and vendor-template-Home.json / vendor-template-ComputeOps-
 *          dashboard.json (Broadcom's templates as shipped on the appliance).
 *   BP     github.com/brockpeterson/operations_dashboards (8.x and 9.x
 *          exports: Cluster CPU Details, Troubleshooting VMs v4, Legacy MSSQL,
 *          Alert and Troubleshoot, ESXi Host Details, VM Details v4 …).
 *   NB     github.com/notoriousbdg/vrops-dashboard-* (VMware's own 8.x
 *          dashboards: cluster_capacity, custom_vm_summary, roi,
 *          cost_by_application, rightsizing_details …).
 *   OTHER  lhuckaba/vROpsESGDash, craigeherring/vROPsDashboards,
 *          vmspot/vROps-Dashboards (TAM Contention Trends),
 *          sconyard/vrops-dashboard-Kubernetes_Namespace_Overview,
 *          vmwarecode/vROPs-8.0---6.7.x-Horizon-Adapter-Dashboard-Content-Pack.
 *   DOCS   Broadcom TechDocs, VCF 9.0, "Widget Definitions List" — the names
 *          in the widget list, and which are deprecated.
 *
 * A type no export showed is in the catalogue with `verified: false` and the
 * config its documentation implies; the dashboard blueprint raises a finding
 * for it.
 */

// ---------------------------------------------------------------------------
// Object types, metric keys and the entries table
// ---------------------------------------------------------------------------

                          
                               
                                
 

/** Short names for the object types dashboards use most, so a row can say "cluster". */
export const KIND_ALIASES                                    = {
  vm: { adapterKind: 'VMWARE', resourceKind: 'VirtualMachine' },
  host: { adapterKind: 'VMWARE', resourceKind: 'HostSystem' },
  cluster: { adapterKind: 'VMWARE', resourceKind: 'ClusterComputeResource' },
  datastore: { adapterKind: 'VMWARE', resourceKind: 'Datastore' },
  datacenter: { adapterKind: 'VMWARE', resourceKind: 'Datacenter' },
  vcenter: { adapterKind: 'VMWARE', resourceKind: 'VMwareAdapter Instance' },
  world: { adapterKind: 'VMWARE', resourceKind: 'vSphere World' },
  resourcepool: { adapterKind: 'VMWARE', resourceKind: 'ResourcePool' },
  namespace: { adapterKind: 'VMWARE', resourceKind: 'Namespace' },
  vks: { adapterKind: 'VMWARE', resourceKind: 'GuestCluster' },
  'vsan-cluster': { adapterKind: 'VirtualAndPhysicalSANAdapter', resourceKind: 'VirtualSANDCCluster' },
  'vsan-diskgroup': { adapterKind: 'VirtualAndPhysicalSANAdapter', resourceKind: 'VirtualSANDiskGroup' },
  'vsan-world': { adapterKind: 'VirtualAndPhysicalSANAdapter', resourceKind: 'vSAN World' },
  'nsx-world': { adapterKind: 'NSXTAdapter', resourceKind: 'NSXT World' },
  'nsx-node': { adapterKind: 'NSXTAdapter', resourceKind: 'TransportNode' },
  'nsx-manager': { adapterKind: 'NSXTAdapter', resourceKind: 'NSXTAdapterInstance' },
  'k8s-namespace': { adapterKind: 'KubernetesAdapter', resourceKind: 'K8S-Namespace' },
  'vcf-world': { adapterKind: 'VcfAdapter', resourceKind: 'VCFWorld' },
  'ops-node': { adapterKind: 'vCenter Operations Adapter', resourceKind: 'vC-Ops-Node' },
};

/**
 * The container each adapter's widgets pin to when they provide for
 * themselves: the importer finds `entries.resource[]` by display name, and the
 * world objects are the ones that exist on every instance (CF render.py,
 * _WORLD_DISPLAY_NAME; "vSphere World", "vSAN World" and "VCF World" are the
 * names in the QA92 and BP exports).
 */
const WORLDS                                                                             = {
  VMWARE: { kind: 'vSphere World', name: 'vSphere World' },
  VirtualAndPhysicalSANAdapter: { kind: 'vSAN World', name: 'vSAN World' },
  NSXTAdapter: { kind: 'NSXT World', name: 'NSX World' },
  VcfAdapter: { kind: 'VCFWorld', name: 'VCF World' },
};

/** "cluster", "VirtualMachine" (the vSphere adapter's) or "NSXTAdapter/TransportNode". */
export function parseKind(text        )                      {
  const value = text.trim();
  if (!value) return undefined;
  const alias = KIND_ALIASES[value.toLowerCase()];
  if (alias) return alias;
  const slash = value.indexOf('/');
  if (slash > 0 && slash < value.length - 1) return { adapterKind: value.slice(0, slash).trim(), resourceKind: value.slice(slash + 1).trim() };
  if (slash >= 0) return undefined;
  return { adapterKind: 'VMWARE', resourceKind: value };
}

/**
 * The literal id a pinned widget writes for an object type: "0020", the
 * adapter kind's length as two digits, the adapter kind, the object type —
 * `002006VMWAREVirtualMachine` (CF render.py adapter_kind_prefix, checked
 * against 50 of 51 adapter kinds in its corpus and the server's own id
 * generator).
 */
export function kindId(kind         )         {
  return `0020${String(kind.adapterKind.length).padStart(2, '0')}${kind.adapterKind}${kind.resourceKind}`;
}

/**
 * Why a metric or property key is not one, or undefined when it looks right.
 *
 * Keys are group|group|name — `cpu|usage_average`, `Super Metric|sm_<id>`,
 * `net:physical|droppedPct` — and are written into the export as they are, so
 * a stray space around a pipe or an empty group is a column that never fills.
 */
export function metricKeyProblem(key        )                     {
  if (!key) return 'is empty';
  if (/[;=\n\t,]/.test(key)) return 'holds a character no metric key has (; = , or a tab)';
  if (key !== key.trim()) return 'starts or ends with a space';
  const parts = key.split('|');
  if (parts.some((part) => part === '')) return 'has an empty group (a leading, trailing or doubled |)';
  if (parts.some((part) => part !== part.trim())) return 'has a space next to a |';
  if (parts.length === 1 && /\s/.test(key)) return 'is words, not a key (keys are group|name, e.g. cpu|usage_average)';
  return undefined;
}

/**
 * `entries` in a dashboard export: the table of object types and objects the
 * widgets refer to by `resourceKind:id:N_::_` and `resource:id:N_::_`. The
 * importer resolves each entry by its keys (and an object by its name) on the
 * target, so the ids are local to the file (CF render.py; every export read).
 */
export class Entries {
                   kinds = new Map                                                        ();
                   resources = new Map                                                                               ();

  kind(ref         )         {
    const key = `${ref.adapterKind}\u0000${ref.resourceKind}`;
    const found = this.kinds.get(key);
    if (found) return found.id;
    const id = `resourceKind:id:${this.kinds.size}_::_`;
    this.kinds.set(key, { ref, id });
    return id;
  }

  resource(ref         , name        )         {
    const key = `${ref.adapterKind}\u0000${ref.resourceKind}\u0000${name}`;
    const found = this.resources.get(key);
    if (found) return found.id;
    const id = `resource:id:${this.resources.size}_::_`;
    this.resources.set(key, { ref, name, id });
    return id;
  }

  toJson()                                                                                   {
    return {
      resourceKind: [...this.kinds.values()].map((entry) => ({ adapterKindKey: entry.ref.adapterKind, internalId: entry.id, resourceKindKey: entry.ref.resourceKind })),
      resource: [...this.resources.values()].map((entry) => ({ adapterKindKey: entry.ref.adapterKind, identifiers: [], internalId: entry.id, name: entry.name, resourceKindKey: entry.ref.resourceKind })),
    };
  }
}

// ---------------------------------------------------------------------------
// Settings: "kind=cluster; metrics=cpu|usage_average,mem|usage_average; top=10"
// ---------------------------------------------------------------------------

                                                                                                                                                       

                                
                       
                             
                        
                              
                                                     
                                       
                        
                        
 

/** Settings that take the rest of the cell, so their text may hold ; and =. */
const REST_KEYS = new Set(['text', 'html']);

export class Settings {
           values = new Map                ();
           malformed           = [];

  constructor(text        ) {
    let rest = text.trim();
    while (rest) {
      const eq = rest.indexOf('=');
      const semi = rest.indexOf(';');
      if (eq < 0 || (semi >= 0 && semi < eq)) {
        const piece = (semi < 0 ? rest : rest.slice(0, semi)).trim();
        if (piece) this.malformed.push(piece);
        rest = semi < 0 ? '' : rest.slice(semi + 1).trim();
        continue;
      }
      const key = rest.slice(0, eq).trim().toLowerCase();
      if (REST_KEYS.has(key)) {
        this.values.set(key, rest.slice(eq + 1).trim());
        break;
      }
      const end = rest.indexOf(';', eq);
      this.values.set(key, (end < 0 ? rest.slice(eq + 1) : rest.slice(eq + 1, end)).trim());
      rest = end < 0 ? '' : rest.slice(end + 1).trim();
    }
  }

  has(key        )          {
    return (this.values.get(key) ?? '') !== '';
  }
  get(key        , fallback = '')         {
    const value = this.values.get(key);
    return value === undefined || value === '' ? fallback : value;
  }
  list(key        )           {
    return this.get(key)
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean);
  }
  num(key        , fallback        )         {
    const value = Number(this.get(key));
    return this.has(key) && Number.isFinite(value) ? value : fallback;
  }
  nums(key        )           {
    return this.list(key).map(Number).filter(Number.isFinite);
  }
  yes(key        , fallback         )          {
    if (!this.has(key)) return fallback;
    return /^(yes|true|on|1)$/i.test(this.get(key));
  }
  kind(key        , fallback          )                      {
    return this.has(key) ? parseKind(this.get(key)) : fallback;
  }
  kinds(key        )            {
    return this.list(key)
      .map(parseKind)
      .filter((kind)                  => kind !== undefined);
  }
}

// ---------------------------------------------------------------------------
// The build context and the pieces widgets share
// ---------------------------------------------------------------------------

                                
                      
                         
                                                                                       
                                 
                                   
                                   
                       
                            
                                                                              
                                   
 

                                      

const EMPTY_FILTER = { filter: [], excludedResources: null, includedResources: null };

/** The four keys nearly every widget's config opens with. */
function common(ctx               )         {
  return {
    refreshInterval: ctx.refreshInterval,
    refreshContent: { refreshContent: ctx.refreshContent },
    selfProvider: { selfProvider: ctx.selfProvider },
    title: ctx.title,
  };
}

/** The tag-picker filter a list or tree writes for the object types it shows. */
function kindFilter(ctx               , kinds                    )         {
  const ids = kinds.map((kind) => ctx.entries.kind(kind));
  return {
    path: ids.map((id) => `/source/kind/kind:${id}`),
    value: { bus: [], adapterKind: [], kind: ids, exclaim: false, healthRange: [], maintenanceSchedule: [], adapterInstance: [], collector: [], tier: [], state: [], tag: [], day: [], status: [] },
  };
}

/** The same filter narrowed to the members of one custom group (craigeherring and GaryFlynn exports). */
function groupFilter(ctx               , group        , groupType        )         {
  const typeRef          = { adapterKind: 'Container', resourceKind: groupType };
  const kindIdRef = ctx.entries.kind(typeRef);
  const res = ctx.entries.resource(typeRef, group);
  return {
    path: [`/source/kind_${kindIdRef}/tag:${res}`],
    value: { adapterInstance: [], adapterKind: [], bus: [], collector: [], day: [], exclaim: false, healthRange: [], kind: [], maintenanceSchedule: [], state: [], status: [], tag: [[res]], tier: [] },
  };
}

/** The world object of the widget's adapter, for a widget that pins itself. */
function worldOf(kind                     )                                                   {
  const world = WORLDS[kind?.adapterKind ?? 'VMWARE'] ?? WORLDS['VMWARE'] ;
  return { ref: { adapterKind: kind?.adapterKind && WORLDS[kind.adapterKind] ? kind.adapterKind : 'VMWARE', resourceKind: world.kind }, name: world.name };
}

/** pin= names what a self-providing widget starts from: "world" (default), or "Adapter/Kind:Name". */
function pinOf(ctx               , kind                     )                                                   {
  const pin = ctx.s.get('pin', 'world');
  if (pin.toLowerCase() === 'world') return worldOf(kind);
  const colon = pin.lastIndexOf(':');
  if (colon > 0) {
    const ref = parseKind(pin.slice(0, colon));
    if (ref) return { ref, name: pin.slice(colon + 1).trim() };
  }
  const ref = parseKind(pin);
  if (!ref) return worldOf(kind);
  // A world kind is found by its display name, which is not always its key ("NSXT World" is "NSX World").
  const world = WORLDS[ref.adapterKind];
  return { ref, name: world && world.kind === ref.resourceKind ? world.name : ref.resourceKind };
}

const THRESHOLD_HELP = 'three numbers: yellow,orange,red';

/**
 * One `resourceKindMetrics[]` entry, as the 9.x renderer writes it: colour by
 * the three bounds (colorMethod 0) when thresholds are given, otherwise
 * dynamic colouring (2); `label` is what the tile or row shows.
 */
function metricEntry(ctx               , kind         , key        , label        , seq        , bounds                   , isString = false)         {
  const thresholds = bounds.length === 3;
  return {
    metricKey: key,
    metricName: key,
    isStringMetric: isString,
    resourceKindId: ctx.entries.kind(kind),
    resourceKindName: kind.resourceKind,
    colorMethod: thresholds ? 0 : isString ? 1 : 2,
    handleOldColoring: false,
    id: `extModel${parseInt(ctx.id.replace(/-/g, '').slice(0, 7), 16) % 100000}-${seq}`,
    label,
    link: '',
    maxValue: ctx.s.has('max') ? String(ctx.s.num('max', 100)) : '',
    metricUnitId: null,
    unit: null,
    yellowBound: thresholds ? bounds[0] : null,
    orangeBound: thresholds ? bounds[1] : null,
    redBound: thresholds ? bounds[2] : null,
  };
}

/** The `metric` object Scoreboard, Metric Chart, Sparkline, Rolling View and Property List share. */
function metricBlock(ctx               , kind         , keys                   , strings                    = [])         {
  const labels = ctx.s.list('labels');
  const bounds = ctx.s.nums('thresholds');
  const all = [...keys.map((key) => ({ key, isString: false })), ...strings.map((key) => ({ key, isString: true }))];
  return {
    mode: 'resourceKind',
    resourceMetrics: [],
    resourceKindMetrics: all.map((metric, index) => metricEntry(ctx, kind, metric.key, labels[index] ?? '', index + 1, metric.isString ? [] : bounds, metric.isString)),
    subMode: 'resourceKindAll',
  };
}

/** additionalColumns on an Object List or Top-N: extra metric columns beside the name. */
function extraColumns(ctx               , kind         , keys                   )           {
  return keys.map((key) => ({ boxLabel: key, metricKey: key, metricName: key, resourceKindId: ctx.entries.kind(kind) }));
}

const PERIODS = ['dashboardTime', 'lastHour', 'last6Hour', 'last24Hour', 'last7Days', 'last30Days']         ;

/** Alert subtypes as the Alert List's type codes carry them, `<type>_<subtype>`, types 15 to 20 (BP and QA92 exports). */
const ALERT_SUBTYPES                                   = { availability: 18, performance: 19, capacity: 20, compliance: 21, configuration: 22 };
const CRITICALITY                                   = { info: 1, warning: 2, immediate: 3, critical: 4 };

const SCOREBOARD_THEMES = ['original', 'solid', 'default', 'simple', 'pastel', 'shadow', 'outline', 'gradient', 'gauge']         ;

// ---------------------------------------------------------------------------
// The catalogue
// ---------------------------------------------------------------------------

                                                                                                                        

                             
                                       
                        
                                                    
                         
                                
                                                                   
                             
                                                                                    
                          
                                                         
                         
                                                 
                                
                                                                                
                             
                                                                          
                                 
                                       
                                                            
                                              
                                                 
 

const S = {
  kind: (required = true, help = 'the object type: cluster, host, vm, datastore … or Adapter/Kind')                => ({ key: 'kind', type: 'kind', required, help }),
  kinds: (required = true)                => ({ key: 'kinds', type: 'kinds', required, help: 'object types, comma separated: cluster,host or Adapter/Kind' }),
  metrics: (required = true)                => ({ key: 'metrics', type: 'metrics', required, help: 'metric keys, comma separated: cpu|usage_average,mem|usage_average' }),
  metric: (required = true, help = 'one metric key: cpu|usage_average')                => ({ key: 'metric', type: 'metric', required, help }),
  labels: { key: 'labels', type: 'text', help: 'labels for the metrics, comma separated, in the same order' }                 ,
  thresholds: { key: 'thresholds', type: 'numbers', help: THRESHOLD_HELP }                 ,
  pin: { key: 'pin', type: 'text', help: 'what a self-providing widget starts from: world (default) or Adapter/Kind:Object name' }                 ,
  depth: (max = 10)                => ({ key: 'depth', type: 'number', min: 1, max, help: 'how many levels below the object to look' }),
  period: { key: 'period', type: 'choice', options: PERIODS, help: 'time range' }                 ,
  refresh: { key: 'refresh', type: 'text', help: 'seconds between refreshes, or off' }                 ,
};

const BLANK_ONLY                           = [S.refresh];

/** Summary badge widgets share one shape (CF survey "IntSummary* family"; BP, NB and QA92 exports). */
function summaryBadge(type        , label        , opts                                                                                                 )             {
  return {
    type,
    label,
    family: 'badge',
    verified: opts.verified,
    source: opts.source,
    ...(opts.note ? { note: opts.note } : {}),
    ...(opts.deprecated ? { deprecated: true } : {}),
    provides: false,
    needsSubject: true,
    size: { w: 3, h: 4 },
    settings: [S.pin, ...(opts.badgeMode ? [{ key: 'badge', type: 'yesno', help: 'show as a badge rather than a chart (badgeMode)' }                 ] : []), S.refresh],
    build: (ctx) => {
      const pin = pinOf(ctx, undefined);
      return {
        refreshInterval: ctx.refreshInterval,
        resource: ctx.selfProvider ? { resourceId: ctx.entries.resource(pin.ref, pin.name), resourceName: pin.name } : null,
        refreshContent: { refreshContent: ctx.refreshContent },
        selfProvider: { selfProvider: ctx.selfProvider },
        ...(opts.badgeMode ? { badgeMode: { badgeMode: ctx.s.yes('badge', false) } } : {}),
        title: ctx.title,
      };
    },
  };
}

const CF = 'sentania-labs/vcf-content-factory src/vcfcf_core/dashboards/render.py (VCF Operations 9, import-verified)';
const SURVEY = 'sentania-labs/vcf-content-factory knowledge/context/api-surface/widget_types_survey.md (live 9.x export)';
const QA92 = 'sentania-labs/vcf-content-factory reference/docs/extracted/dashboard-widgets (9.2 export and Broadcom appliance templates)';
const BP = 'brockpeterson/operations_dashboards';
const NB = 'notoriousbdg/vrops-dashboard-*';
const DOCS = 'Broadcom TechDocs VCF 9.0 "Widget Definitions List" (no export seen)';

export const WIDGET_TYPES                        = [
  {
    type: 'ResourceList',
    label: 'Object List',
    family: 'list',
    verified: true,
    source: `${CF} _resource_list_widget; ${NB} (cost_by_application), GaryFlynn/vrops-dashboards-vm-uptime (custom-group filter)`,
    provides: true,
    needsSubject: false,
    size: { w: 4, h: 6 },
    settings: [
      S.kinds(false),
      { key: 'group', type: 'text', help: 'only the members of this custom group' },
      { key: 'grouptype', type: 'text', help: 'the custom group’s type (default Environment)' },
      { key: 'columns', type: 'metrics', help: 'extra metric columns, comma separated' },
      { key: 'first', type: 'yesno', help: 'select the first row on open (default yes)' },
      S.depth(),
      S.refresh,
    ],
    build: (ctx) => {
      const kinds = ctx.s.kinds('kinds');
      const group = ctx.s.get('group');
      return {
        ...common(ctx),
        resource: [],
        relationshipMode: { relationshipMode: 0 },
        additionalColumns: extraColumns(ctx, kinds[0] ?? KIND_ALIASES['vm'] , ctx.s.list('columns')),
        mode: 'all',
        filterMode: 'tagPicker',
        tagFilter: group ? groupFilter(ctx, group, ctx.s.get('grouptype', 'Environment')) : kindFilter(ctx, kinds),
        depth: ctx.s.num('depth', 1),
        customFilter: EMPTY_FILTER,
        selectFirstRow: { selectFirstRow: ctx.s.yes('first', true) },
      };
    },
  },
  {
    type: 'View',
    label: 'View',
    family: 'list',
    verified: true,
    source: `${CF} _view_widget; ${NB} (cluster_capacity) and 680 View widgets in the exports read`,
    note: 'The view must exist before the dashboard is imported: generate it with "A view for dashboards and reports" (same name, so the same id) or give a built-in view’s UUID.',
    provides: true,
    needsSubject: true,
    size: { w: 12, h: 6 },
    settings: [
      { key: 'view', type: 'text', required: true, help: 'the view’s name (generated by the view blueprint) or its UUID' },
      { key: 'first', type: 'yesno', help: 'select the first row on open' },
      { key: 'legend', type: 'choices', options: ['legend', 'labels', 'title'], help: 'for a chart view: what to show (chartViewItems)' },
      S.pin,
      S.refresh,
    ],
    build: (ctx) => {
      const pin = pinOf(ctx, undefined);
      const resId = ctx.selfProvider ? ctx.entries.resource(pin.ref, pin.name) : '';
      return {
        refreshInterval: ctx.refreshInterval,
        resource: ctx.selfProvider ? { resourceId: resId, traversalSpecId: '', resourceName: pin.name, resourceKindId: kindId(pin.ref), id: `Ext.vcops.chrome.model.Resource-${Number(resId.replace(/\D/g, '')) + 1}` } : null,
        traversalSpecId: null,
        refreshContent: { refreshContent: false },
        isUpdatedView: true,
        chartViewItems: ctx.s.list('legend'),
        selectFirstRow: { selectFirstRow: ctx.s.yes('first', false) },
        selfProvider: { selfProvider: ctx.selfProvider },
        title: ctx.title,
        viewDefinitionId: ctx.viewId(ctx.s.get('view')),
      };
    },
  },
  {
    type: 'Scoreboard',
    label: 'Scoreboard',
    family: 'chart',
    verified: true,
    source: `${CF} _scoreboard_widget; ${NB} (custom_vm_summary, roi), aakib011/vROPS-Dashboards, lhuckaba/vROpsESGDash`,
    provides: false,
    needsSubject: true,
    size: { w: 4, h: 4 },
    settings: [
      S.kind(),
      S.metrics(),
      S.labels,
      S.thresholds,
      { key: 'theme', type: 'choice', options: SCOREBOARD_THEMES, help: 'tile style; gauge draws dials (default gradient)' },
      { key: 'columns', type: 'number', min: 1, max: 12, help: 'tiles per row (default 4)' },
      { key: 'layout', type: 'choice', options: ['fixedView', 'fixedSize', 'floatingView'], help: 'tile layout (default fixedView)' },
      { key: 'sparkline', type: 'yesno', help: 'a sparkline under each value' },
      S.period,
      { key: 'decimals', type: 'number', min: 0, max: 5, help: 'decimal places (default 1)' },
      { key: 'max', type: 'number', help: 'full scale of a gauge' },
      { key: 'cells', type: 'number', min: 1, max: 1000, help: 'most tiles shown (default 100)' },
      { key: 'names', type: 'yesno', help: 'show object names (default no)' },
      S.refresh,
    ],
    build: (ctx) => {
      const kind = ctx.s.kind('kind', KIND_ALIASES['vm']) ;
      const theme = SCOREBOARD_THEMES.indexOf(ctx.s.get('theme', 'gradient')                                      ) + 1 || 8;
      return {
        ...common(ctx),
        metric: metricBlock(ctx, kind, ctx.s.list('metrics')),
        resource: [],
        relationshipMode: { relationshipMode: 0 },
        customFilter: EMPTY_FILTER,
        depth: 1,
        resInteractionMode: null,
        visualTheme: theme,
        mode: { layoutMode: ctx.s.get('layout', 'fixedView') },
        showResourceName: { showResourceName: ctx.s.yes('names', false) },
        showMetricName: { showMetricName: true },
        showMetricUnit: { showMetricUnit: true },
        showDT: { showDT: true },
        showSparkline: { showSparkline: ctx.s.yes('sparkline', false) },
        periodLength: ctx.s.has('period') ? ctx.s.get('period') : null,
        maxCellCount: ctx.s.num('cells', 100),
        oldMetricValues: true,
        roundDecimals: ctx.s.num('decimals', 1),
        valueSize: 24,
        labelSize: 12,
        boxHeight: null,
        boxColumns: ctx.s.num('columns', 4),
        ...(theme === 9 ? { showRemaining: false, showPercentText: false, focusOnPercent: false } : {}),
      };
    },
  },
  {
    type: 'ScoreboardHealth',
    label: 'Scoreboard Health',
    family: 'badge',
    verified: true,
    source: SURVEY,
    provides: false,
    needsSubject: true,
    size: { w: 3, h: 4 },
    settings: [{ key: 'badge', type: 'choice', options: ['health', 'risk', 'efficiency'], help: 'which score (default health)' }, { key: 'image', type: 'choice', options: ['circle', 'square'], help: 'badge shape (default circle)' }, S.refresh],
    build: (ctx) => ({ ...common(ctx), metricType: { metricType: ctx.s.get('badge', 'health') }, metricValue: '', resources: [], imageType: ctx.s.get('image', 'circle') }),
  },
  {
    type: 'Heatmap',
    label: 'Heat Map',
    family: 'chart',
    verified: true,
    source: `${CF} _heatmap_widget; ${BP} (Cluster CPU Details: sizeBy num_Cpu, colorBy cpu|usage_average, groupBy HostSystem)`,
    provides: true,
    needsSubject: false,
    size: { w: 6, h: 6 },
    settings: [
      S.kind(true, 'the objects drawn as tiles'),
      { key: 'colorby', type: 'metric', required: true, help: 'the metric that colours a tile' },
      { key: 'sizeby', type: 'metric', help: 'the metric that sizes a tile (default: all the same size)' },
      { key: 'groupby', type: 'kind', help: 'group tiles under this object type (default: the tile type itself)' },
      { key: 'values', type: 'numbers', help: 'colour stops, ascending: 0,50,100' },
      { key: 'colors', type: 'colors', help: 'one colour per stop, #rrggbb: #8ABF5B,#EACC58,#E4695E' },
      { key: 'min', type: 'number', help: 'lowest value on the colour scale (default 0)' },
      { key: 'max', type: 'number', help: 'highest value on the colour scale (default 100)' },
      { key: 'solid', type: 'yesno', help: 'solid colours rather than a gradient' },
      S.depth(),
      S.refresh,
    ],
    build: (ctx) => {
      const kind = ctx.s.kind('kind', KIND_ALIASES['vm']) ;
      const group = ctx.s.kind('groupby') ?? kind;
      const values = ctx.s.nums('values');
      const colors = ctx.s.list('colors');
      const sizeBy = ctx.s.get('sizeby');
      return {
        mode: 'all',
        depth: ctx.s.num('depth', 10),
        selfProvider: { selfProvider: ctx.selfProvider },
        refreshInterval: ctx.refreshInterval,
        refreshContent: { refreshContent: ctx.refreshContent },
        resource: [],
        relationshipMode: { relationshipMode: [1, -1, 0] },
        title: ctx.title,
        configs: [
          {
            name: ctx.title,
            resourceKind: ctx.entries.kind(kind),
            colorBy: { metricKey: ctx.s.get('colorby'), value: ctx.s.get('colorby') },
            sizeBy: { metricKey: sizeBy || null, value: sizeBy },
            groupBy: {
              resourceKind: group.resourceKind,
              adapterKind: group.adapterKind,
              typeId: ctx.entries.kind(group),
              type: 'resourceKind',
              text: group.resourceKind,
              originalText: group.resourceKind,
              id: `004null${kindId(group)}`,
              parentText: group.adapterKind,
              parentId: group.adapterKind,
            },
            thenBy: null,
            color: {
              minValue: ctx.s.num('min', 0),
              maxValue: ctx.s.num('max', 100),
              thresholds: { values: values.length > 0 ? values : [0, 50, 100], colors: colors.length > 0 ? colors : ['#8ABF5B', '#EACC58', '#E4695E'] },
            },
            focusOnGroups: true,
            relationalGrouping: false,
            solidColoring: ctx.s.yes('solid', false),
            mode: { mode: false },
            attributeKind: { value: '' },
            filterMode: 'tagPicker',
            tagFilter: null,
            customFilter: EMPTY_FILTER,
          },
        ],
        value: 0,
      };
    },
  },
  {
    type: 'HealthChart',
    label: 'Health Chart',
    family: 'chart',
    verified: true,
    source: `${CF} _health_chart_widget; ${QA92} (vendor-template-Home); ${BP} (ESXi Host Details v2)`,
    note: 'metric=badge|health, badge|risk or badge|efficiency charts the score (metricType health/risk/efficiency); any other key is a custom metric.',
    provides: true,
    needsSubject: true,
    size: { w: 6, h: 4 },
    settings: [
      S.kind(),
      S.metric(true, 'the metric charted: cpu|usage_average, or badge|health'),
      S.thresholds,
      { key: 'order', type: 'choice', options: ['asc', 'desc'], help: 'sort order (default asc)' },
      { key: 'rows', type: 'number', min: 1, max: 100, help: 'objects per page (default 15)' },
      { key: 'height', type: 'number', min: 60, max: 400, help: 'bar height in pixels (default 135)' },
      { key: 'mode', type: 'choice', options: ['all', 'self', 'resource'], help: 'all the objects below the one sent (default), just that one, or a pinned one' },
      S.period,
      S.depth(),
      S.refresh,
    ],
    build: (ctx) => {
      const kind = ctx.s.kind('kind', KIND_ALIASES['vm']) ;
      const metric = ctx.s.get('metric');
      const badge = /^badge\|(health|risk|efficiency)$/.exec(metric)?.[1];
      const bounds = ctx.s.nums('thresholds');
      const pin = pinOf(ctx, kind);
      return {
        ...common(ctx),
        resource: ctx.selfProvider ? [{ name: pin.name, id: ctx.entries.resource(pin.ref, pin.name) }] : [],
        relationshipMode: { relationshipMode: 0 },
        mode: ctx.s.get('mode', 'all'),
        filterMode: 'tagPicker',
        tagFilter: null,
        depth: ctx.s.num('depth', 1),
        customFilter: EMPTY_FILTER,
        metricKey: metric,
        metricName: metric,
        metricFullName: metric,
        resourceKindId: ctx.entries.kind(kind),
        metricUnit: { metricUnitId: -1, metricUnitName: 'Default Unit' },
        metricType: { metricType: badge ?? 'custom' },
        chartHeight: ctx.s.num('height', 135),
        yellowBound: bounds.length === 3 ? bounds[0] : null,
        orangeBound: bounds.length === 3 ? bounds[1] : null,
        redBound: bounds.length === 3 ? bounds[2] : null,
        sortBy: 'metricValue',
        sortByDir: { orderByDir: ctx.s.get('order', 'asc') },
        paginationNumber: ctx.s.num('rows', 15),
        showResourceName: { showResourceName: true },
        showMetricLabel: { showMetricLabel: false },
        metricLabel: '',
        selectFirstRow: { selectFirstRow: false },
        ...(ctx.s.has('period') ? { periodLength: ctx.s.get('period') } : {}),
      };
    },
  },
  {
    type: 'MetricChart',
    label: 'Metric Chart',
    family: 'chart',
    verified: true,
    source: `${CF} _metric_chart_widget (relationshipMode is a scalar here: an array makes the widget fail); ${BP} (ESXi Host Performance Details v2); ${NB} (cluster_capacity)`,
    note: 'Line, area or bar is a per-user preference kept in the widget’s states, not in config; it opens as a line chart.',
    provides: false,
    needsSubject: true,
    size: { w: 6, h: 5 },
    settings: [S.kind(), S.metrics(), S.labels, { key: 'relationship', type: 'choice', options: ['self', 'children', 'parents'], help: 'chart the object sent, one line per child, or per parent (default self)' }, S.refresh],
    build: (ctx) => {
      const kind = ctx.s.kind('kind', KIND_ALIASES['vm']) ;
      const relationship = { children: -1, parents: 1 }[ctx.s.get('relationship', 'self')                          ] ?? 0;
      return {
        ...common(ctx),
        metric: metricBlock(ctx, kind, ctx.s.list('metrics')),
        resource: [],
        relationshipMode: { relationshipMode: relationship },
        customFilter: EMPTY_FILTER,
        depth: 1,
        resInteractionMode: null,
      };
    },
  },
  {
    type: 'SparklineChart',
    label: 'Sparkline Chart',
    family: 'chart',
    verified: true,
    source: `${SURVEY} §SparklineChart; ${BP} (VM Details v4)`,
    provides: false,
    needsSubject: true,
    size: { w: 4, h: 5 },
    settings: [S.kind(), S.metrics(), S.labels, { key: 'order', type: 'choice', options: ['graphFirst', 'tableFirst'], help: 'graph or value first (default graphFirst)' }, { key: 'names', type: 'yesno', help: 'show the object name' }, S.refresh],
    build: (ctx) => {
      const kind = ctx.s.kind('kind', KIND_ALIASES['vm']) ;
      return {
        ...common(ctx),
        resource: [],
        showDT: { showDT: true },
        relationshipMode: { relationshipMode: 0 },
        showResourceName: { showObjectName: ctx.s.yes('names', false) },
        depth: 1,
        columnSequence: { columnSequence: ctx.s.get('order', 'graphFirst') },
        metric: metricBlock(ctx, kind, ctx.s.list('metrics')),
        customFilter: EMPTY_FILTER,
        resInteractionMode: null,
      };
    },
  },
  {
    type: 'ParetoAnalysis',
    label: 'Top-N',
    family: 'chart',
    verified: true,
    source: `${CF} _pareto_analysis_widget (mode all); ${NB} (reclaimable_hosts, storage_tier_cost_analysis), lhuckaba/vROpsESGDash`,
    provides: true,
    needsSubject: false,
    size: { w: 4, h: 6 },
    settings: [
      S.kind(),
      S.metric(),
      { key: 'top', type: 'number', min: 1, max: 100, help: 'how many bars (default 10)' },
      { key: 'order', type: 'choice', options: ['highest', 'lowest'], help: 'the highest or the lowest values (default highest)' },
      { key: 'label', type: 'text', help: 'what the metric is called on the chart' },
      { key: 'columns', type: 'metrics', help: 'extra metric columns, comma separated' },
      S.thresholds,
      { key: 'decimals', type: 'number', min: 0, max: 5, help: 'decimal places (default 1)' },
      { key: 'every', type: 'number', min: 1, max: 1440, help: 'minutes between recalculations (default 15)' },
      S.depth(),
      S.refresh,
    ],
    build: (ctx) => {
      const kind = ctx.s.kind('kind', KIND_ALIASES['vm']) ;
      const metric = ctx.s.get('metric');
      const bounds = ctx.s.nums('thresholds');
      return {
        ...common(ctx),
        resource: [],
        relationshipMode: { relationshipMode: [-1, 0] },
        mode: 'all',
        filterMode: 'tagPicker',
        tagFilter: null,
        depth: ctx.s.num('depth', 10),
        customFilter: EMPTY_FILTER,
        filterOldMetrics: { filterOldMetrics: false },
        topOption: ctx.s.get('order', 'highest') === 'lowest' ? 'metricsLowestUtilization' : 'metricsHighestUtilization',
        barsCount: ctx.s.num('top', 10),
        roundDecimals: ctx.s.num('decimals', 1),
        regenerationTime: ctx.s.num('every', 15),
        percentileValue: null,
        metricName: ctx.s.get('label', metric),
        metricUnit: { metricUnitId: -1, metricUnitName: 'Auto' },
        additionalColumns: extraColumns(ctx, kind, ctx.s.list('columns')),
        metric: { metricKey: metric, name: ctx.s.get('label', metric) },
        resourceKind: [{ id: ctx.entries.kind(kind) }],
        ...(bounds.length === 3 ? { yellowBound: bounds[0], orangeBound: bounds[1], redBound: bounds[2] } : {}),
      };
    },
  },
  {
    type: 'RollingViewChart',
    label: 'Rolling View Chart',
    family: 'chart',
    verified: true,
    source: 'vmspot/vROps-Dashboards (TAM Contention Trends), craigeherring/vROPsDashboards (8.x exports)',
    provides: false,
    needsSubject: true,
    size: { w: 6, h: 5 },
    settings: [S.kind(), S.metrics(), S.labels, { key: 'interval', type: 'number', min: 5, max: 3600, help: 'seconds each metric is shown (default 30)' }, { key: 'toolbar', type: 'yesno', help: 'show the chart toolbar (default yes)' }, S.refresh],
    build: (ctx) => {
      const kind = ctx.s.kind('kind', KIND_ALIASES['vm']) ;
      return {
        ...common(ctx),
        autoTransitionInterval: ctx.s.num('interval', 30),
        metric: metricBlock(ctx, kind, ctx.s.list('metrics')),
        relationshipMode: 0,
        resInteractionMode: null,
        resourceMetrics: [],
        showChartToolbar: { showChartToolbar: ctx.s.yes('toolbar', true) },
      };
    },
  },
  {
    type: 'MashupChart',
    label: 'Mashup Chart',
    family: 'chart',
    verified: true,
    source: `${SURVEY} §MashupChart (config is the four common keys; what it charts is kept in the widget’s states)`,
    provides: false,
    needsSubject: true,
    size: { w: 6, h: 6 },
    settings: BLANK_ONLY,
    build: (ctx) => common(ctx),
  },
  {
    type: 'PropertyList',
    label: 'Property List',
    family: 'list',
    verified: true,
    source: `${CF} _property_list_widget (showMetricFullName’s inner key is metricFullName); ${NB} (cluster_capacity, rightsizing_details)`,
    provides: false,
    needsSubject: true,
    size: { w: 4, h: 5 },
    settings: [
      S.kind(),
      S.metrics(false),
      { key: 'props', type: 'metrics', help: 'text properties, comma separated: config|name,summary|parentHost' },
      S.labels,
      { key: 'theme', type: 'number', min: 0, max: 5, help: 'style 0 to 5 (default 0)' },
      { key: 'fullnames', type: 'yesno', help: 'show full metric names (default yes)' },
      S.refresh,
    ],
    build: (ctx) => {
      const kind = ctx.s.kind('kind', KIND_ALIASES['vm']) ;
      return {
        ...common(ctx),
        visualTheme: ctx.s.num('theme', 0),
        depth: 1,
        metric: metricBlock(ctx, kind, ctx.s.list('metrics'), ctx.s.list('props')),
        resource: [],
        relationshipMode: { relationshipMode: 0 },
        customFilter: EMPTY_FILTER,
        showMetricFullName: { metricFullName: ctx.s.yes('fullnames', true) },
        resInteractionMode: null,
      };
    },
  },
  {
    type: 'TextDisplay',
    label: 'Text Display',
    family: 'text',
    verified: true,
    source: `${CF} _text_display_widget; ${NB} (cluster_capacity), lhuckaba/vROpsESGDash (HTML in editorData)`,
    note: 'text= is shown as written (escaped); html= is custom HTML, as the editor’s HTML mode keeps it; url= loads a page (a ContentPack/… path or a web address). text= and html= take the rest of the cell.',
    provides: false,
    needsSubject: false,
    size: { w: 12, h: 2 },
    settings: [{ key: 'url', type: 'text', help: 'a page to show instead of text' }, { key: 'text', type: 'rest', help: 'plain text (the rest of the cell)' }, { key: 'html', type: 'rest', help: 'custom HTML (the rest of the cell)' }, S.refresh],
    build: (ctx) => {
      const html = ctx.s.has('html') ? ctx.s.get('html') : `<div style="font-size: 14px;">${escapeHtml(ctx.s.get('text'))}</div>`;
      return {
        editorData: ctx.s.has('url') ? '' : html,
        locationFile: '',
        locationUrl: ctx.s.get('url'),
        refreshInterval: ctx.refreshInterval,
        refreshContent: { refreshContent: false },
        title: ctx.title,
        titleLocalized: ctx.title,
        viewModeHTML: true,
      };
    },
  },
  {
    type: 'Section',
    label: 'Section',
    family: 'text',
    verified: true,
    source: `${QA92} (qa-9.2.0 export, vendor ComputeOps template); ${CF} _section_widget; ${BP} (vCenter and ESX Host Versions)`,
    note: 'A full-width collapsible heading. It is 12 wide and 1 high whatever the row says, and holds the widgets below it down to the next Section.',
    provides: false,
    needsSubject: false,
    size: { w: 12, h: 1 },
    settings: [{ key: 'collapsed', type: 'yesno', help: 'start collapsed' }, { key: 'description', type: 'text', help: 'a line under the heading' }],
    build: (ctx) => ({ title: ctx.title, titleLocalized: ctx.title, description: ctx.s.get('description'), widgets: [] }),
  },
  {
    type: 'AlertList',
    label: 'Alert List',
    family: 'alert',
    verified: true,
    source: `${CF} _alert_list_widget; ${QA92} (License Server Alerts); ${BP} (Alert and Troubleshoot, Cluster Capacity Details v7)`,
    note: 'Type codes are <type>_<subtype> for types 15 to 20, as the exports have them (…_19 performance, …_20 capacity); availability, compliance and configuration use the subtype numbers the alert definitions API lists (18, 21, 22). impact= values are the badge names; exports only ever showed [].',
    provides: true,
    needsSubject: false,
    size: { w: 12, h: 5 },
    settings: [
      S.kinds(false),
      { key: 'criticality', type: 'choices', options: Object.keys(CRITICALITY), help: 'which criticalities (default warning,immediate,critical)' },
      { key: 'status', type: 'choice', options: ['active', 'all'], help: 'active alerts only (default) or all' },
      { key: 'types', type: 'choices', options: Object.keys(ALERT_SUBTYPES), help: 'alert subtypes' },
      { key: 'impact', type: 'choices', options: ['health', 'risk', 'efficiency'], help: 'badges the alerts affect' },
      { key: 'definitions', type: 'text', help: 'alert definition ids, comma separated' },
      { key: 'world', type: 'yesno', help: 'query the whole vSphere World rather than a sent object' },
      S.depth(),
      S.refresh,
    ],
    build: (ctx) => {
      const kinds = ctx.s.kinds('kinds');
      const world = ctx.s.yes('world', false);
      const pin = worldOf(kinds[0]);
      const types = ctx.s.list('types').flatMap((name) => {
        const sub = ALERT_SUBTYPES[name.toLowerCase()];
        return sub === undefined ? [] : [15, 16, 17, 18, 19, 20].map((type) => `${type}_${sub}`);
      });
      const crit = (ctx.s.has('criticality') ? ctx.s.list('criticality') : ['warning', 'immediate', 'critical']).map((c) => CRITICALITY[c.toLowerCase()]).filter((n)              => n !== undefined);
      return {
        refreshInterval: ctx.refreshInterval,
        resource: world ? [{ resourceId: ctx.entries.resource(pin.ref, pin.name), resourceName: pin.name }] : [],
        refreshContent: { refreshContent: ctx.refreshContent },
        relationshipMode: { relationshipMode: [-1, 0] },
        selfProvider: { selfProvider: world ? false : ctx.selfProvider },
        title: ctx.title,
        mode: 'all',
        filterMode: 'tagPicker',
        tagFilter: kinds.length > 0 ? kindFilter(ctx, kinds) : null,
        depth: ctx.s.num('depth', 1),
        customFilter: EMPTY_FILTER,
        criticalityLevel: crit,
        type: types,
        status: ctx.s.get('status', 'active') === 'all' ? [] : [0],
        state: [],
        alertImpact: ctx.s.list('impact'),
        alertAction: [],
        alertDefinitions: ctx.s.list('definitions').map((id) => ({ id })),
      };
    },
  },
  {
    type: 'ProblemAlertsList',
    label: 'Top Alerts',
    family: 'alert',
    verified: true,
    source: `${CF} _problem_alerts_list_widget; ${NB} (custom_vm_summary), sconyard/vrops-dashboard-Kubernetes_Namespace_Overview`,
    provides: true,
    needsSubject: true,
    size: { w: 4, h: 5 },
    settings: [
      { key: 'badge', type: 'choice', options: ['health', 'risk', 'efficiency', 'all'], help: 'alerts affecting which badge (default health)' },
      { key: 'objects', type: 'choice', options: ['self', 'children', 'selfChildren'], help: 'alerts on the object, on its children, or both (default children)' },
      { key: 'limit', type: 'number', min: 1, max: 50, help: 'how many alerts (default 5)' },
      S.pin,
      S.refresh,
    ],
    build: (ctx) => {
      const pin = pinOf(ctx, undefined);
      const badge = ctx.s.get('badge', 'health');
      return {
        refreshInterval: ctx.refreshInterval,
        resource: ctx.selfProvider ? { resourceId: ctx.entries.resource(pin.ref, pin.name), resourceName: pin.name } : null,
        refreshContent: { refreshContent: ctx.refreshContent },
        selfProvider: { selfProvider: ctx.selfProvider },
        title: ctx.title,
        impactedBadge: badge === 'all' ? '' : badge,
        triggeredObject: { triggeredObject: ctx.s.get('objects', 'children') },
        topIssuesDisplayLimit: ctx.s.num('limit', 5),
      };
    },
  },
  {
    type: 'IntSummaryAlertVolume',
    label: 'Alert Volume',
    family: 'alert',
    verified: true,
    source: `${CF} _alert_volume_widget; ${QA92} (vendor-template-Home); ${BP} (Alert and Troubleshoot)`,
    provides: false,
    needsSubject: true,
    size: { w: 4, h: 4 },
    settings: [S.pin, S.refresh],
    build: (ctx) => {
      const pin = pinOf(ctx, undefined);
      return {
        refreshInterval: ctx.refreshInterval,
        ...(ctx.selfProvider ? { resource: { resourceId: ctx.entries.resource(pin.ref, pin.name), resourceName: pin.name } } : {}),
        refreshContent: { refreshContent: ctx.refreshContent },
        selfProvider: { selfProvider: ctx.selfProvider },
        title: ctx.title,
      };
    },
  },
  summaryBadge('IntSummaryHealth', 'Health', { verified: true, source: `${QA92} (qa-9.2.0 export: Health State of the Environment)`, badgeMode: true }),
  summaryBadge('IntSummaryRisk', 'Risk', { verified: true, source: `${SURVEY} (same shape as Health, with badgeMode)`, deprecated: true, badgeMode: true }),
  summaryBadge('IntSummaryEfficiency', 'Efficiency', { verified: true, source: `${SURVEY} (same shape as Health, with badgeMode)`, deprecated: true, badgeMode: true }),
  summaryBadge('IntSummaryCapacity', 'Capacity Remaining', { verified: true, source: `${BP} (Cluster Capacity Trends and Projections); ${NB} (custom_vm_summary)` }),
  summaryBadge('IntSummaryTimeRemaining', 'Time Remaining', { verified: true, source: `${NB} (cluster_capacity); ${BP} (Environment Capacity v2)` }),
  summaryBadge('IntSummaryWorkload', 'Workload', { verified: true, source: 'vmspot/vROps-Dashboards (TAM Contention Trends)' }),
  summaryBadge('IntSummaryStress', 'Stress', { verified: true, source: `${NB} (custom_vm_summary: config {})`, note: 'Not in VCF 9.0’s widget list; it imports from 8.x content.' }),
  summaryBadge('IntSummaryFaults', 'Faults', { verified: false, source: `${DOCS}; the type name is the one this toolkit’s own reader knows (src/aria/aria.ts)`, deprecated: true, note: 'Config assumed to be the IntSummary shape.' }),
  summaryBadge('IntSummaryAnomalies', 'Anomalies', { verified: false, source: DOCS, deprecated: true, note: 'Type name and config assumed from the IntSummary family.' }),
  summaryBadge('IntSummaryCurrentPolicy', 'Current Policy', { verified: false, source: DOCS, deprecated: true, note: 'Type name and config assumed from the IntSummary family.' }),
  summaryBadge('IntSummaryEnvironment', 'Environment', { verified: false, source: DOCS, deprecated: true, note: 'Type name and config assumed from the IntSummary family.' }),
  {
    type: 'Skittles',
    label: 'Environment Overview',
    family: 'badge',
    verified: true,
    source: `${SURVEY} §Skittles (mode custom, badge[], custom[] of object types); ${NB} (cost_by_application: config {})`,
    note: 'The type is Skittles in the export: coloured badge dots per object type.',
    provides: true,
    needsSubject: true,
    size: { w: 6, h: 4 },
    settings: [S.kinds(), { key: 'badges', type: 'choices', options: ['health', 'risk', 'efficiency'], help: 'which badges (default all three)' }, S.refresh],
    build: (ctx) => {
      const shown = ctx.s.has('badges') ? ctx.s.list('badges').map((b) => b.toLowerCase()) : ['health', 'risk', 'efficiency'];
      return {
        mode: 'custom',
        badge: ['health', 'risk', 'efficiency'].map((key) => ({ badgeKey: key, badgeName: key[0] .toUpperCase() + key.slice(1), show: shown.includes(key), label: null })),
        custom: ctx.s.kinds('kinds').map((kind) => ({ resourceKindName: kind.resourceKind, resourceKindId: ctx.entries.kind(kind) })),
        selfProvider: { selfProvider: ctx.selfProvider },
        refreshInterval: ctx.refreshInterval,
        refreshContent: { refreshContent: ctx.refreshContent },
        title: ctx.title,
      };
    },
  },
  {
    type: 'ResourceRelationshipAdvanced',
    label: 'Object Relationship (Advanced)',
    family: 'relationship',
    verified: true,
    source: `${CF} _resource_relationship_advanced_widget; ${BP} (Cluster Details v2, Alert and Troubleshoot); ${QA92}`,
    provides: true,
    needsSubject: true,
    size: { w: 6, h: 6 },
    settings: [
      S.kinds(false),
      { key: 'depth', type: 'text', help: 'levels up,down from the object (default 2,2)' },
      { key: 'traversal', type: 'text', help: 'traversal spec (default vSphere Hosts and Clusters-VMWARE-vSphere World)' },
      { key: 'rows', type: 'number', min: 1, max: 100, help: 'rows per page (default 5)' },
      { key: 'first', type: 'yesno', help: 'select the first object on open' },
      S.refresh,
    ],
    build: (ctx) => ({
      resourceId: null,
      refreshInterval: ctx.refreshInterval,
      traversalSpecId: ctx.s.get('traversal', 'vSphere Hosts and Clusters-VMWARE-vSphere World'),
      refreshContent: { refreshContent: ctx.refreshContent },
      resourceName: null,
      title: ctx.title,
      filterMode: 'tagPicker',
      tagFilter: ctx.s.kinds('kinds').length > 0 ? kindFilter(ctx, ctx.s.kinds('kinds')) : null,
      paginationNumber: ctx.s.num('rows', 5),
      depth: ctx.s.get('depth', '2,2'),
      customFilter: EMPTY_FILTER,
      selectFirstRow: { selectFirstRow: ctx.s.yes('first', false) },
      selfProvider: { selfProvider: ctx.selfProvider },
    }),
  },
  {
    type: 'ResourceRelationship',
    label: 'Object Relationship',
    family: 'relationship',
    verified: true,
    source: `${BP} (ESXi Host Details, vCenter Server Health); vmwarecode/vROPs-8.0---6.7.x-Horizon-Adapter-Dashboard-Content-Pack`,
    provides: true,
    needsSubject: true,
    size: { w: 6, h: 5 },
    settings: [S.kinds(false), { key: 'nodesize', type: 'number', min: 8, max: 64, help: 'node size (default 18)' }, { key: 'autozoom', type: 'yesno', help: 'fit to the widget' }, S.refresh],
    build: (ctx) => ({
      filterMode: 'tagPicker',
      tagFilter: ctx.s.kinds('kinds').length > 0 ? kindFilter(ctx, ctx.s.kinds('kinds')) : null,
      resourceId: null,
      nodeSize: ctx.s.num('nodesize', 18),
      refreshInterval: ctx.refreshInterval,
      autoZoom: { autoSize: ctx.s.yes('autozoom', false) },
      refreshContent: { refreshContent: ctx.refreshContent },
      customFilter: EMPTY_FILTER,
      resourceName: null,
      selfProvider: { selfProvider: ctx.selfProvider },
      title: ctx.title,
    }),
  },
  {
    type: 'TopologyGraph',
    label: 'Topology Graph',
    family: 'relationship',
    verified: true,
    source: `${BP} (Legacy MSSQL Dashboards: MS-SQL-Database.json)`,
    note: 'Writes the default topology configuration (defaultTopologyGraphConfig.xml, force layout, parent and child relationships) over the vSphere Hosts and Clusters traversal; pick another configuration in the editor.',
    provides: true,
    needsSubject: true,
    size: { w: 6, h: 6 },
    settings: [{ key: 'depth', type: 'number', min: 1, max: 10, help: 'levels shown (default 2)' }, { key: 'layout', type: 'choice', options: ['force', 'hierarchical'], help: 'graph layout (default force)' }, S.refresh],
    build: (ctx) => ({
      custom: [
        {
          lightWeightRelationships: [
            { id: 'extModel1-1', key: 'widget.topologyGraph.parent', lineStyle: 'solid', name: '', propKeyPrefix: '', relationship: '~child', subType: '', type: '~child' },
            { id: 'extModel1-2', key: 'widget.topologyGraph.child', lineStyle: 'solid', name: '', propKeyPrefix: '', relationship: 'child', subType: '', type: 'child' },
          ],
          selectedConfigFile: 'defaultTopologyGraphConfig.xml',
          selectedLayoutType: ctx.s.get('layout', 'force'),
          travSpecs: [{ description: 'vSphere Hosts and Clusters', id: 'extModel2-1', key: 'vSphere Hosts and Clusters-VMWARE-vSphere World', name: 'vSphere Hosts and Clusters', relations: ['~child', 'child'] }],
        },
      ],
      depth: ctx.s.num('depth', 2),
      filterMode: { leafExpand: true },
      mode: 'node',
      refreshContent: { refreshContent: ctx.refreshContent },
      refreshInterval: ctx.refreshInterval,
      resInteractionMode: null,
      resource: { resourceName: '' },
      resources: [{ resourceName: '' }, { resourceName: '' }],
      selfProvider: { selfProvider: ctx.selfProvider },
      title: ctx.title,
      treeType: { treeType: false },
    }),
  },
  {
    type: 'MetricPicker',
    label: 'Metric Picker',
    family: 'picker',
    verified: true,
    source: `${BP} (Alert and Troubleshoot, Troubleshooting VMs v3)`,
    note: 'It sends a metric, not an object: a widget that receives from it is wired with interaction type metricId, as the exports have it.',
    provides: true,
    needsSubject: true,
    size: { w: 4, h: 6 },
    settings: BLANK_ONLY,
    build: (ctx) => ({ refreshInterval: ctx.refreshInterval, refreshContent: { refreshContent: ctx.refreshContent }, title: ctx.title }),
  },
  {
    type: 'TagPicker',
    label: 'Tag Picker',
    family: 'picker',
    verified: true,
    source: `${SURVEY} §TagPicker (config is refreshInterval and refreshContent)`,
    provides: true,
    needsSubject: false,
    size: { w: 3, h: 6 },
    settings: BLANK_ONLY,
    build: (ctx) => ({ refreshInterval: ctx.refreshInterval, refreshContent: { refreshContent: ctx.refreshContent } }),
  },
  {
    type: 'Geo',
    label: 'Geo',
    family: 'other',
    verified: false,
    source: `${SURVEY} §Geo (config keys only: customFilter, filterMode, refreshContent, refreshInterval, selfProvider, tagFilter, title)`,
    note: 'The keys are from a live export; their values were not shown. Objects appear only when their Geo Location tag is set.',
    provides: true,
    needsSubject: false,
    size: { w: 6, h: 6 },
    settings: [S.kinds(false), S.refresh],
    build: (ctx) => ({ ...common(ctx), filterMode: 'tagPicker', tagFilter: ctx.s.kinds('kinds').length > 0 ? kindFilter(ctx, ctx.s.kinds('kinds')) : null, customFilter: EMPTY_FILTER }),
  },
  {
    type: 'LogAnalysis',
    label: 'Log Analysis',
    family: 'logs',
    verified: true,
    source: `${BP} (Troubleshooting VMs v4: Log Analysis for selected VM and parent ESXi Host)`,
    note: 'Needs VCF Operations for logs integrated. The export seen had an empty query; query= is written as its search text, which is not confirmed.',
    provides: false,
    needsSubject: true,
    size: { w: 12, h: 6 },
    settings: [
      { key: 'chart', type: 'choice', options: ['column', 'bar', 'line', 'area', 'pie', 'scalar'], help: 'chart type (default column)' },
      { key: 'show', type: 'choice', options: ['all', 'chart', 'events'], help: 'what the widget shows (default all)' },
      { key: 'relationship', type: 'choice', options: ['self', 'children', 'parents'], help: 'logs of the object, its children, or its parents too (default parents)' },
      { key: 'query', type: 'text', help: 'search text' },
      { key: 'rows', type: 'number', min: 1, max: 1000, help: 'events returned (default 50)' },
      S.refresh,
    ],
    build: (ctx) => ({
      queryFilter_searchtext: ctx.s.has('query') ? [ctx.s.get('query')] : [],
      refreshInterval: ctx.refreshInterval,
      resource: [],
      refreshContent: { refreshContent: ctx.refreshContent },
      relationshipMode: { relationshipMode: { self: 0, children: -1, parents: 1 }[ctx.s.get('relationship', 'parents')                                   ] ?? 1 },
      queryFilter: { size: ctx.s.num('rows', 50), query: { bool: { filter: [] } } },
      title: ctx.title,
      liViewMode: ctx.s.get('show', 'all'),
      liOverTime: { isOverTime: true, groupBy: [] },
      liAggregationFunction: { eventType: 'count' },
      mode: 'all',
      depth: 1,
      chartType: ctx.s.get('chart', 'column'),
      liQueryMode: 1,
      selfProvider: { selfProvider: ctx.selfProvider },
    }),
  },
  {
    type: 'RecommendedActions',
    label: 'Recommended Actions',
    family: 'other',
    verified: true,
    source: `${QA92} (vendor-template-Home: config {})`,
    provides: false,
    needsSubject: false,
    size: { w: 6, h: 8 },
    settings: [],
    build: () => ({}),
  },
  {
    type: 'ActionsResult',
    label: 'Data Collection Results',
    family: 'other',
    verified: true,
    source: 'vmwarecode/vROPs-8.0---6.7.x-Horizon-Adapter-Dashboard-Content-Pack (C4 dashboards)',
    note: 'Which actions it offers depends on the object’s adapter; set them in the editor.',
    provides: false,
    needsSubject: true,
    size: { w: 6, h: 5 },
    settings: BLANK_ONLY,
    build: (ctx) => ({ ...common(ctx), dataCollectionDefaultActions: [], dataCollectionOnInteraction: { dataCollectionOnInteraction: false }, dataCollectionSelectedResource: {} }),
  },
  {
    type: 'ContainerDetails',
    label: 'Container Details',
    family: 'other',
    verified: true,
    source: 'sconyard/vrops-dashboard-Kubernetes_Namespace_Overview (config {})',
    provides: false,
    needsSubject: true,
    size: { w: 6, h: 5 },
    settings: [],
    build: () => ({}),
  },
  {
    type: 'ContainerOverview',
    label: 'Container Overview',
    family: 'other',
    verified: false,
    source: `${SURVEY} (type counted on a live instance, config not shown); ${DOCS}`,
    deprecated: true,
    provides: true,
    needsSubject: false,
    size: { w: 6, h: 5 },
    settings: BLANK_ONLY,
    build: (ctx) => common(ctx),
  },
  {
    type: 'Forensics',
    label: 'Forensics',
    family: 'chart',
    verified: false,
    source: `${DOCS}; VCF 9.0 "Forensics Widget Configuration Options" (object, metric, time range)`,
    note: 'Type name and config keys follow the other metric widgets; configure it in the editor if it opens empty.',
    provides: false,
    needsSubject: true,
    size: { w: 6, h: 5 },
    settings: [S.kind(), S.metric(), S.period, S.refresh],
    build: (ctx) => {
      const kind = ctx.s.kind('kind', KIND_ALIASES['vm']) ;
      return { ...common(ctx), metricKey: ctx.s.get('metric'), resourceKindId: ctx.entries.kind(kind), periodLength: ctx.s.get('period', 'last7Days') };
    },
  },
  {
    type: 'WeatherMap',
    label: 'Weather Map',
    family: 'chart',
    verified: false,
    source: DOCS,
    deprecated: true,
    note: 'Deprecated in VCF 9.0. Type name and config keys follow the other metric widgets.',
    provides: false,
    needsSubject: true,
    size: { w: 6, h: 5 },
    settings: [S.kind(), S.metric(), S.period, S.refresh],
    build: (ctx) => {
      const kind = ctx.s.kind('kind', KIND_ALIASES['vm']) ;
      return { ...common(ctx), metricKey: ctx.s.get('metric'), resourceKindId: ctx.entries.kind(kind), periodLength: ctx.s.get('period', 'last24Hour') };
    },
  },
  {
    type: 'WorkloadBalance',
    label: 'DRS Cluster Settings',
    family: 'other',
    verified: false,
    source: `${DOCS}; the type name is the one this toolkit’s own reader knows (src/aria/aria.ts)`,
    deprecated: true,
    provides: false,
    needsSubject: true,
    size: { w: 6, h: 5 },
    settings: BLANK_ONLY,
    build: (ctx) => common(ctx),
  },
  {
    type: 'EnvironmentStatus',
    label: 'Environment Status',
    family: 'badge',
    verified: false,
    source: DOCS,
    deprecated: true,
    provides: false,
    needsSubject: false,
    size: { w: 4, h: 4 },
    settings: BLANK_ONLY,
    build: (ctx) => common(ctx),
  },
  {
    type: 'AnomalyBreakdown',
    label: 'Anomaly Breakdown',
    family: 'chart',
    verified: false,
    source: DOCS,
    provides: false,
    needsSubject: true,
    size: { w: 6, h: 5 },
    settings: BLANK_ONLY,
    build: (ctx) => common(ctx),
  },
  {
    type: 'WorkloadPattern',
    label: 'Workload Pattern',
    family: 'chart',
    verified: false,
    source: DOCS,
    provides: false,
    needsSubject: true,
    size: { w: 6, h: 5 },
    settings: BLANK_ONLY,
    build: (ctx) => common(ctx),
  },
];

const BY_TYPE = new Map(WIDGET_TYPES.map((type) => [type.type.toLowerCase(), type]));
const BY_LABEL = new Map(WIDGET_TYPES.map((type) => [type.label.toLowerCase(), type]));

/** A widget type by its export name or its name in the widget list ("Top-N", "Object List"). */
export function widgetType(name        )                         {
  const key = name.trim().toLowerCase();
  return BY_TYPE.get(key) ?? BY_LABEL.get(key);
}

/** Problems with one row's settings for its type: what is missing, malformed, or not a value it takes. */
export function settingProblems(type            , settings          , selfProvider         )                                           {
  const errors           = [];
  const warnings           = [];
  const known = new Map(type.settings.map((setting) => [setting.key, setting]));
  for (const piece of settings.malformed) errors.push(`"${piece}" is not key=value`);
  for (const key of settings.values.keys()) {
    if (!known.has(key)) warnings.push(`${key}= is not a ${type.label} setting (it takes ${type.settings.map((s) => s.key).join(', ') || 'none'}) and is ignored`);
  }
  for (const setting of type.settings) {
    const raw = settings.get(setting.key);
    if (!raw) {
      if (setting.required) errors.push(`${setting.key}= is required (${setting.help})`);
      continue;
    }
    switch (setting.type) {
      case 'kind':
        if (!parseKind(raw)) errors.push(`${setting.key}=${raw} is not an object type (an alias such as cluster, or Adapter/Kind)`);
        break;
      case 'kinds':
        for (const part of settings.list(setting.key)) if (!parseKind(part)) errors.push(`${setting.key}: ${part} is not an object type`);
        break;
      case 'metric':
      case 'metrics':
        for (const key of setting.type === 'metric' ? [raw] : settings.list(setting.key)) {
          const problem = metricKeyProblem(key);
          if (problem) errors.push(`${setting.key}: "${key}" ${problem}`);
        }
        if (setting.type === 'metric' && raw.includes(',')) errors.push(`${setting.key}= takes one metric key`);
        break;
      case 'number': {
        const value = Number(raw);
        if (!Number.isFinite(value)) errors.push(`${setting.key}=${raw} is not a number`);
        else if ((setting.min !== undefined && value < setting.min) || (setting.max !== undefined && value > setting.max)) errors.push(`${setting.key}=${raw} is outside ${setting.min ?? '−∞'} to ${setting.max ?? '∞'}`);
        break;
      }
      case 'numbers':
        if (settings.list(setting.key).some((part) => !Number.isFinite(Number(part)))) errors.push(`${setting.key}=${raw} is not a list of numbers`);
        else if (setting.key === 'thresholds') {
          const bounds = settings.nums('thresholds');
          if (bounds.length !== 3) errors.push(`thresholds= takes three numbers (yellow,orange,red), not ${bounds.length}`);
          else if (!(bounds[0]  <= bounds[1]  && bounds[1]  <= bounds[2] ) && !(bounds[0]  >= bounds[1]  && bounds[1]  >= bounds[2] )) errors.push(`thresholds=${raw} are not in order, so the colours cannot band`);
        }
        break;
      case 'choice':
        if (!(setting.options ?? []).some((option) => option.toLowerCase() === raw.toLowerCase())) errors.push(`${setting.key}=${raw} is not one of ${(setting.options ?? []).join(', ')}`);
        break;
      case 'choices':
        for (const part of settings.list(setting.key)) if (!(setting.options ?? []).some((option) => option.toLowerCase() === part.toLowerCase())) errors.push(`${setting.key}: ${part} is not one of ${(setting.options ?? []).join(', ')}`);
        break;
      case 'yesno':
        if (!/^(yes|no|true|false|on|off|1|0)$/i.test(raw)) errors.push(`${setting.key}=${raw} is not yes or no`);
        break;
      case 'colors':
        for (const part of settings.list(setting.key)) if (!/^#[0-9a-f]{6}$/i.test(part)) errors.push(`${setting.key}: ${part} is not a #rrggbb colour`);
        break;
      default:
        break;
    }
  }
  if (settings.has('refresh') && !/^(off|\d+)$/i.test(settings.get('refresh'))) errors.push(`refresh=${settings.get('refresh')} is seconds or off`);
  // One colour per stop (BP export), or one more for values past the last stop (CF survey).
  if (type.type === 'Heatmap' && (settings.has('values') || settings.has('colors'))) {
    const stops = settings.has('values') ? settings.nums('values').length : 3;
    const colours = settings.has('colors') ? settings.list('colors').length : 3;
    if (colours !== stops && colours !== stops + 1) errors.push(`colors= needs one colour per value in values= (${stops}), or one more`);
  }
  if (type.type === 'TextDisplay' && !settings.has('text') && !settings.has('html') && !settings.has('url')) errors.push('a Text Display needs text=, html= or url=');
  if (type.type === 'PropertyList' && !settings.has('metrics') && !settings.has('props')) errors.push('a Property List needs metrics= or props=');
  if (!selfProvider && settings.has('pin')) warnings.push('pin= only applies when the widget provides for itself (Provider yes)');
  return { errors, warnings };
}

function escapeHtml(text        )         {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** One line per type, for the field's help: the name to type and the settings it takes (* required). */
export function catalogueHelp()         {
  const lines = WIDGET_TYPES.map((type) => {
    const settings = type.settings.map((setting) => `${setting.key}${setting.required ? '*' : ''}`).join(', ');
    return `${type.type} (${type.label}${type.deprecated ? ', deprecated' : ''}${type.verified ? '' : ', unverified'}): ${settings || 'no settings'}`;
  });
  return [
    'Settings are key=value pairs separated by ";". Object types are aliases (vm, host, cluster, datastore, datacenter, vcenter, world, namespace, vks, vsan-cluster, nsx-node, nsx-world, k8s-namespace …) or Adapter/Kind. Metric keys are as VCF Operations writes them (cpu|usage_average). text= and html= take the rest of the cell. Position is x,y,w,h on the 12-column grid, w,h to place it automatically at that size, or auto. Provider yes makes the widget pick its own objects; Receives from names the widget whose selection drives it.',
    ...lines,
  ].join('\n');
}
