/**
 * Loading a dashboard export into the dashboard builder, and writing it back.
 *
 * A real dashboard carries far more than the builder's rows can say: keys a
 * widget's editor writes that no row setting maps to, per-user `states`,
 * widget types the catalogue has never seen, interactions of a kind the rows
 * do not model (a second sender, a tag picker), navigations to dashboards
 * known only by id. None of it may be lost by opening the dashboard here and
 * saving it again.
 *
 * So loading does two things. It reads each widget into a row — type, title,
 * settings, position, provider, receives from — as far as the catalogue
 * understands it, for the builder to show and edit. And it keeps the export
 * itself, whole, in the `imported` value. Generating then starts from the
 * export and applies only what was edited: the rows as loaded are built once
 * (the base), the rows as they are now are built again (the next), and only
 * the parts of the output that differ between the two are written over the
 * original. A dashboard loaded and generated with no edits comes back as it
 * was exported; an edited setting changes the keys that setting writes, and
 * nothing else.
 */

                                                              
import { stableId } from '../vcfops-import.js';
import {
  ALERT_SUBTYPES,
  COLUMN_PROPORTIONS,
  CRITICALITY,
  DASHBOARD_KEYS,
  DASHBOARD_TIME_RANGES,
  Entries,
  METRIC_UNITS,
  SCOREBOARD_THEMES,
  Settings,
  TOPN_ORDERS,
  filterText,
  WORLDS,
  kindAlias,
  widgetType,
               
                     
                  
} from './vcf-ops-widgets.js';

                    
                                

const isObj = (value      )               => typeof value === 'object' && value !== null && !Array.isArray(value);
const arr = (value      )         => (Array.isArray(value) ? value : []);
const str = (value      )         => (typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value));
const numOf = (value      )                     => (typeof value === 'number' && Number.isFinite(value) ? value : typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value)) ? Number(value) : undefined);
const inner = (value      , key        )       => (isObj(value) ? value[key] : undefined);

export function deepEqual(a      , b      )          {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) => deepEqual(item, b[index]));
  }
  if (isObj(a) && isObj(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const key of keys) if (!deepEqual(a[key], b[key])) return false;
    return true;
  }
  return false;
}

export const clone =    (value   )    => (value === undefined ? value : (JSON.parse(JSON.stringify(value))     ));

/**
 * Three-way merge: `original` changed by the difference between `base` (what
 * the builder writes for the rows as loaded) and `next` (what it writes for
 * them now). Where base and next agree, the original stands.
 */
export function merge3(original      , base      , next      )       {
  if (deepEqual(base, next)) return clone(original);
  if (isObj(original) && isObj(base) && isObj(next)) {
    const out      = clone(original);
    for (const key of new Set([...Object.keys(base), ...Object.keys(next)])) {
      if (!(key in next)) delete out[key];
      else out[key] = merge3(original[key], base[key], next[key]);
    }
    return out;
  }
  return clone(next);
}

// ---------------------------------------------------------------------------
// The kept export
// ---------------------------------------------------------------------------

/** The six row cells, as loaded: Type | Title | Settings | Position | Provider | Receives from. */
                                                                                 

/** Everything kept from the export, carried in the `imported` value. */
                              
                      
                                                                 
                        
                                                                                 
                    
                         
                                           
                          
                                                                               
                                                                       
                                                
                                                    
                                                                             
                                                             
                                                            
                                    
     
                                                                              
                                                                            
     
                                                    
 

export function readStore(text         )                          {
  if (typeof text !== 'string' || !text.trim()) return undefined;
  try {
    const json = JSON.parse(text)        ;
    if (isObj(json) && json['version'] === 1 && isObj(json['dashboard']) && isObj(json['rows'])) return json                          ;
  } catch {
    // An unreadable store is ignored: the rows still build on their own.
  }
  return undefined;
}

/** The original widget a loaded row came from. */
export function storeWidget(store             , id        )                  {
  return arr(store.dashboard['widgets']).filter(isObj).find((widget) => str(widget['id']) === id);
}

/**
 * The type a loaded widget of a type the catalogue does not have builds as:
 * its own config, verbatim. It may send a selection (the rows cannot know),
 * and it takes no settings.
 */
export function passthroughType(widget     )             {
  const coords = isObj(widget['gridsterCoords']) ? widget['gridsterCoords'] : {};
  const type = str(widget['type']) || 'Unknown';
  return {
    type,
    label: type,
    family: 'other',
    verified: true,
    source: 'the loaded export (kept as it was)',
    note: 'A widget type the builder does not know. It is written back exactly as it was loaded; only its title and place can be changed here.',
    provides: true,
    needsSubject: false,
    size: { w: Math.max(1, Math.min(12, numOf(coords['w']) ?? 4)), h: Math.max(1, numOf(coords['h']) ?? 4) },
    settings: [],
    build: (ctx) => {
      const config = isObj(widget['config']) ? clone(widget['config']) : {};
      if ('title' in config) config['title'] = ctx.title;
      return config;
    },
  };
}

// ---------------------------------------------------------------------------
// Choosing a dashboard
// ---------------------------------------------------------------------------

                                  
                               
                                  
                      
                        
                           
                        
 

/** Every dashboard in what was read, once each (a bundle holds the same one as .json and in its zip). */
export function dashboardChoices(exports                               )                    {
  const out                    = [];
  const seen                               = [];
  exports.forEach((exp, exportIndex) => {
    arr(exp.json['dashboards']).forEach((dashboard, dashboardIndex) => {
      if (!isObj(dashboard)) return;
      const id = str(dashboard['id']);
      if (seen.some((s) => s.id === id && deepEqual(s.json, dashboard))) return;
      seen.push({ id, json: dashboard });
      out.push({ exportIndex, dashboardIndex, id, name: str(dashboard['name']) || '(no name)', widgets: arr(dashboard['widgets']).length, file: exp.file });
    });
  });
  return out;
}

// ---------------------------------------------------------------------------
// Reading a widget's config back into row settings
// ---------------------------------------------------------------------------

/** Row text cannot hold " | " (it separates cells), a newline, or ";" inside a value. */
const cell = (text        )         => text.replace(/[\r\n\t]+/g, ' ').replace(/\s+\|\s+/g, '|').trim();
const value = (text        )         => cell(text).replace(/;/g, ',');
/** A single value that may not hold a comma (it would read as a list). */
const cellValue = (text        )         => value(text).replace(/,/g, ' ');

                  
                            
                                     
 

function metricsOf(config      )                                                                                                            {
  const block = inner(config, 'metric');
  const list = arr(inner(block, 'resourceKindMetrics')).filter(isObj);
  const first = list[0];
  const bounds = first && numOf(first['yellowBound']) !== undefined && numOf(first['orangeBound']) !== undefined && numOf(first['redBound']) !== undefined ? ([numOf(first['yellowBound']) , numOf(first['orangeBound']) , numOf(first['redBound']) ]                            ) : undefined;
  return {
    kind: first ? str(first['resourceKindId']) : undefined,
    keys: list.filter((m) => m['isStringMetric'] !== true).map((m) => str(m['metricKey'])).filter(Boolean),
    strings: list.filter((m) => m['isStringMetric'] === true).map((m) => str(m['metricKey'])).filter(Boolean),
    labels: list.map((m) => str(m['label'])),
    ...(bounds ? { bounds } : {}),
  };
}

function kindsOfFilter(reader        , filter      )           {
  return arr(inner(inner(filter, 'value'), 'kind'))
    .map((id) => reader.kind(id))
    .filter((k)              => !!k);
}

/** pin= for a self-providing widget pinned to something other than its adapter's world object. */
function pinOf(reader        , config      )                     {
  const resource = inner(config, 'resource');
  const first = Array.isArray(resource) ? resource.find(isObj) : resource;
  const id = str(inner(first, 'resourceId') ?? inner(first, 'id'));
  if (!id) return undefined;
  const found = reader.entries.resourceOf(id);
  if (!found) return undefined;
  const world = Object.values(WORLDS).find((w) => w.kind === found.ref.resourceKind && w.name === found.name);
  if (world && found.ref.adapterKind === 'VMWARE') return undefined;
  return `${kindAlias(found.ref)}:${found.name}`;
}

const yes = (flag      )         => (flag === true ? 'yes' : 'no');

/** The row settings a widget's config says, as far as the catalogue's settings reach. */
export function settingsFromConfig(type            , config      , reader        , widget     )                         {
  const s                         = {};
  const set = (key        , v                             )       => {
    if (v === undefined || v === '') return;
    s[key] = String(v);
  };
  const c = isObj(config) ? config : {};
  const pin = pinOf(reader, c);
  const pinned = ()       => {
    if (type.settings.some((x) => x.key === 'pin') && c['selfProvider'] && inner(c['selfProvider'], 'selfProvider') === true) set('pin', pin);
  };
  const metricBlock = (withProps = false)       => {
    const m = metricsOf(c);
    set('kind', m.kind ? reader.kind(m.kind) : undefined);
    set('metrics', m.keys.join(','));
    if (withProps) set('props', m.strings.join(','));
    if (m.labels.some(Boolean)) set('labels', m.labels.map(value).join(','));
    if (m.bounds) set('thresholds', m.bounds.join(','));
  };
  /** objectmetrics= from resourceMetrics[] {metricKey, resourceId}. */
  const objectMetrics = ()                     => {
    const out           = [];
    for (const m of arr(c['resourceMetrics'])) {
      const found = reader.entries.resourceOf(str(inner(m, 'resourceId')));
      const key = str(inner(m, 'metricKey'));
      if (!found || !key || /[,;=:]/.test(found.name) || /[,;=]/.test(key)) return undefined;
      out.push(`${kindAlias(found.ref)}:${found.name}=${key}`);
    }
    return out.join(',') || undefined;
  };
  /** unit= and link= when every metric row of the block shares one. */
  const metricUnitAndLink = ()       => {
    const rows = arr(inner(c['metric'], 'resourceKindMetrics')).filter(isObj);
    if (rows.length === 0) return;
    const units = [...new Set(rows.map((m) => str(m['metricUnitId'])))];
    if (units.length === 1 && METRIC_UNITS[units[0] ]) set('unit', units[0]);
    const links = [...new Set(rows.map((m) => str(m['link'])))];
    if (links.length === 1 && links[0] && !/[;,\s]/.test(links[0])) set('link', links[0]);
  };
  const columns = ()       => {
    const cols = arr(c['additionalColumns']).filter(isObj);
    set('columns', cols.map((col) => str(col['metricKey'])).filter(Boolean).join(','));
    const labels = cols.map((col) => str(col['boxLabel']));
    if (cols.some((col) => str(col['boxLabel']) !== str(col['metricKey'])) && labels.every((l) => l && !/[,;]/.test(l))) set('columnlabels', labels.map(value).join(','));
  };
  const groupOf = ()       => {
    const paths = arr(inner(c['tagFilter'], 'path'));
    const group = /^\/source\/kind_([^/]+)\/tag:(.+)$/.exec(str(paths[0]));
    const res = group ? reader.entries.resourceOf(group[2] ) : undefined;
    if (res && paths.length === 1) {
      set('group', value(res.name));
      if (res.ref.resourceKind !== 'Environment') set('grouptype', value(res.ref.resourceKind));
    }
  };
  const depth = (fallback        )       => {
    const d = numOf(c['depth']);
    if (d !== undefined && d !== fallback) set('depth', d);
  };
  switch (type.type) {
    case 'ResourceList': {
      const path = str(arr(inner(c['tagFilter'], 'path'))[0]);
      const group = /^\/source\/kind_([^/]+)\/tag:(.+)$/.exec(path);
      const res = group ? reader.entries.resourceOf(group[2] ) : undefined;
      if (res) {
        set('group', value(res.name));
        if (res.ref.resourceKind !== 'Environment') set('grouptype', value(res.ref.resourceKind));
      } else set('kinds', kindsOfFilter(reader, c['tagFilter']).join(','));
      columns();
      if (inner(c['selectFirstRow'], 'selectFirstRow') === false) set('first', 'no');
      depth(1);
      break;
    }
    case 'View':
      set('view', str(c['viewDefinitionId']));
      if (inner(c['selectFirstRow'], 'selectFirstRow') === true) set('first', 'yes');
      set('legend', arr(c['chartViewItems']).map(str).filter((x) => ['legend', 'labels', 'title'].includes(x)).join(','));
      pinned();
      break;
    case 'Scoreboard': {
      metricBlock();
      const theme = numOf(c['visualTheme']);
      if (theme !== undefined && theme !== 8 && SCOREBOARD_THEMES[theme - 1]) set('theme', SCOREBOARD_THEMES[theme - 1]);
      const cols = numOf(c['boxColumns']);
      if (cols !== undefined && cols !== 4) set('columns', cols);
      const layout = str(inner(c['mode'], 'layoutMode'));
      if (layout && layout !== 'fixedView' && ['fixedSize', 'floatingView'].includes(layout)) set('layout', layout);
      if (inner(c['showSparkline'], 'showSparkline') === true) set('sparkline', 'yes');
      if (typeof c['periodLength'] === 'string') set('period', c['periodLength']);
      const dec = numOf(c['roundDecimals']);
      if (dec !== undefined && dec !== 1) set('decimals', dec);
      const cells = numOf(c['maxCellCount']);
      if (cells !== undefined && cells !== 100) set('cells', cells);
      if (inner(c['showResourceName'], 'showResourceName') === true) set('names', 'yes');
      const max = numOf(arr(inner(c['metric'], 'resourceKindMetrics')).map((m) => inner(m, 'maxValue'))[0]);
      if (max !== undefined) set('max', max);
      metricUnitAndLink();
      break;
    }
    case 'ScoreboardHealth':
      set('badge', str(inner(c['metricType'], 'metricType')) === 'health' ? undefined : str(inner(c['metricType'], 'metricType')));
      if (str(c['imageType']) && str(c['imageType']) !== 'circle') set('image', str(c['imageType']));
      break;
    case 'Heatmap': {
      const conf = arr(c['configs']).find(isObj);
      if (conf) {
        const kind = reader.kind(conf['resourceKind']);
        set('kind', kind);
        set('colorby', str(inner(conf['colorBy'], 'metricKey')));
        set('sizeby', str(inner(conf['sizeBy'], 'metricKey')));
        const g = conf['groupBy'];
        const gk = str(inner(g, 'adapterKind')) && str(inner(g, 'resourceKind')) ? kindAlias({ adapterKind: str(inner(g, 'adapterKind')), resourceKind: str(inner(g, 'resourceKind')) }) : undefined;
        if (gk && gk !== kind) set('groupby', gk);
        const th = inner(conf['color'], 'thresholds');
        set('values', arr(inner(th, 'values')).map(str).join(','));
        set('colors', arr(inner(th, 'colors')).map(str).join(','));
        const min = numOf(inner(conf['color'], 'minValue'));
        const max = numOf(inner(conf['color'], 'maxValue'));
        if (min !== undefined && min !== 0) set('min', min);
        if (max !== undefined && max !== 100) set('max', max);
        if (conf['solidColoring'] === true) set('solid', 'yes');
        const t = conf['thenBy'];
        if (str(inner(t, 'adapterKind')) && str(inner(t, 'resourceKind'))) set('thenby', kindAlias({ adapterKind: str(inner(t, 'adapterKind')), resourceKind: str(inner(t, 'resourceKind')) }));
        if (conf['relationalGrouping'] === true) set('relational', 'yes');
        if (inner(conf['mode'], 'mode') === true) set('heatmode', 'instance');
        if (conf['focusOnGroups'] === false) set('focus', 'no');
        if (str(conf['name']) && str(conf['name']) !== str(c['title'])) set('configname', cellValue(str(conf['name'])));
        const f = filterText(conf['customFilter']);
        if (f?.filter) {
          set('filter', f.filter);
          if (f.kind) set('filterkind', kindAlias(f.kind));
        }
      }
      depth(10);
      break;
    }
    case 'HealthChart': {
      set('kind', reader.kind(c['resourceKindId']));
      set('metric', str(c['metricKey']));
      const b = [numOf(c['yellowBound']), numOf(c['orangeBound']), numOf(c['redBound'])];
      if (b.every((x) => x !== undefined)) set('thresholds', b.join(','));
      const order = str(inner(c['sortByDir'], 'orderByDir'));
      if (order === 'desc') set('order', order);
      const rows = numOf(c['paginationNumber']);
      if (rows !== undefined && rows !== 15) set('rows', rows);
      const height = numOf(c['chartHeight']);
      if (height !== undefined && height !== 135) set('height', height);
      if (['self', 'resource'].includes(str(c['mode']))) set('mode', str(c['mode']));
      if (typeof c['periodLength'] === 'string') set('period', c['periodLength']);
      set('kinds', kindsOfFilter(reader, c['tagFilter']).join(','));
      pinned();
      depth(1);
      break;
    }
    case 'MetricChart': {
      metricBlock();
      metricUnitAndLink();
      set('objectmetrics', objectMetrics());
      break;
    }
    case 'SparklineChart':
      metricBlock();
      if (str(inner(c['columnSequence'], 'columnSequence')) === 'labelFirst') set('order', 'labelFirst');
      if (inner(c['showResourceName'], 'showObjectName') === true) set('names', 'yes');
      break;
    case 'RollingViewChart': {
      metricBlock();
      const interval = numOf(c['autoTransitionInterval']);
      if (interval !== undefined && interval !== 30) set('interval', interval);
      if (inner(c['showChartToolbar'], 'showChartToolbar') === false) set('toolbar', 'no');
      metricUnitAndLink();
      break;
    }
    case 'PropertyList': {
      metricBlock(true);
      metricUnitAndLink();
      const theme = numOf(c['visualTheme']);
      if (theme !== undefined && theme !== 0) set('theme', theme);
      if (inner(c['showMetricFullName'], 'metricFullName') === false) set('fullnames', 'no');
      break;
    }
    case 'ParetoAnalysis': {
      set('kind', reader.kind(inner(arr(c['resourceKind'])[0], 'id')));
      const metric = str(inner(c['metric'], 'metricKey'));
      set('metric', metric);
      const top = numOf(c['barsCount']);
      if (top !== undefined && top !== 10) set('top', top);
      const option = str(c['topOption']);
      const order = Object.entries(TOPN_ORDERS).find(([, v]) => v === option)?.[0];
      if (order && order !== 'highest') set('order', order);
      const label = str(inner(c['metric'], 'name')) || str(c['metricName']);
      if (label && label !== metric) set('label', value(label));
      columns();
      groupOf();
      const b = [numOf(c['yellowBound']), numOf(c['orangeBound']), numOf(c['redBound'])];
      if (b.every((x) => x !== undefined)) set('thresholds', b.join(','));
      const dec = numOf(c['roundDecimals']);
      if (dec !== undefined && dec !== 1) set('decimals', dec);
      const every = numOf(c['regenerationTime']);
      if (every !== undefined && every !== 15) set('every', every);
      depth(10);
      break;
    }
    case 'TextDisplay': {
      const url = str(c['locationUrl']);
      if (url) set('url', value(url));
      else if (str(c['locationFile'])) set('file', value(str(c['locationFile'])));
      else {
        const html = str(c['editorData']);
        const plain = /^<div style="font-size: 14px;">([\s\S]*)<\/div>$/.exec(html);
        const text = plain ? plain[1] .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&') : undefined;
        if (text !== undefined && !/[<>]/.test(text)) set('text', cell(text));
        else if (html) set('html', cell(html));
      }
      break;
    }
    case 'Section':
      set('description', value(str(c['description'])));
      break;
    case 'AlertList': {
      set('kinds', kindsOfFilter(reader, c['tagFilter']).join(','));
      groupOf();
      const crit = arr(c['criticalityLevel'])
        .map((n) => Object.entries(CRITICALITY).find(([, v]) => v === numOf(n))?.[0])
        .filter((x)              => !!x);
      if (crit.join(',') !== 'warning,immediate,critical') set('criticality', crit.join(','));
      if (Array.isArray(c['status']) && c['status'].length === 0) set('status', 'all');
      const subs = [...new Set(arr(c['type']).map((t) => Number(str(t).split('_')[1])))].map((n) => Object.entries(ALERT_SUBTYPES).find(([, v]) => v === n)?.[0]).filter((x)              => !!x);
      set('types', subs.join(','));
      set('impact', arr(c['alertImpact']).map(str).filter((x) => ['health', 'risk', 'efficiency'].includes(x)).join(','));
      set('definitions', arr(c['alertDefinitions']).map((d) => str(inner(d, 'id'))).filter(Boolean).join(','));
      if (arr(c['resource']).some((r) => isObj(r) && 'resourceId' in r) && inner(c['selfProvider'], 'selfProvider') !== true) set('world', 'yes');
      depth(1);
      break;
    }
    case 'ProblemAlertsList': {
      const badge = str(c['impactedBadge']);
      if (badge !== 'health') set('badge', badge === '' ? 'all' : badge);
      const objects = str(inner(c['triggeredObject'], 'triggeredObject'));
      if (objects && objects !== 'children') set('objects', objects);
      const limit = numOf(c['topIssuesDisplayLimit']);
      if (limit !== undefined && limit !== 5) set('limit', limit);
      pinned();
      break;
    }
    case 'Skittles': {
      set('kinds', arr(c['custom']).map((k) => reader.kind(inner(k, 'resourceKindId'))).filter(Boolean).join(','));
      const shown = arr(c['badge']).filter((b) => inner(b, 'show') === true).map((b) => str(inner(b, 'badgeKey')));
      if (arr(c['badge']).length > 0 && shown.length < 3) set('badges', shown.join(','));
      break;
    }
    case 'ResourceRelationshipAdvanced': {
      set('kinds', kindsOfFilter(reader, c['tagFilter']).join(','));
      if (str(c['depth']) && str(c['depth']) !== '2,2') set('depth', str(c['depth']));
      const trav = str(c['traversalSpecId']);
      if (trav && trav !== 'vSphere Hosts and Clusters-VMWARE-vSphere World') set('traversal', value(trav));
      const rows = numOf(c['paginationNumber']);
      if (rows !== undefined && rows !== 5) set('rows', rows);
      if (inner(c['selectFirstRow'], 'selectFirstRow') === true) set('first', 'yes');
      break;
    }
    case 'ResourceRelationship': {
      set('kinds', kindsOfFilter(reader, c['tagFilter']).join(','));
      const size = numOf(c['nodeSize']);
      if (size !== undefined && size !== 18) set('nodesize', size);
      if (inner(c['autoZoom'], 'autoSize') === true) set('autozoom', 'yes');
      break;
    }
    case 'TopologyGraph': {
      const d = numOf(c['depth']);
      if (d !== undefined && d !== 2) set('depth', d);
      const layout = str(inner(arr(c['custom'])[0], 'selectedLayoutType'));
      if (layout === 'hierarchical') set('layout', layout);
      const file = str(inner(arr(c['custom'])[0], 'selectedConfigFile'));
      if (file && file !== 'defaultTopologyGraphConfig.xml') set('configfile', value(file));
      break;
    }
    case 'Geo':
    case 'ParetoChart':
      set('kinds', kindsOfFilter(reader, c['tagFilter']).join(','));
      break;
    case 'WorkloadBalance':
      set('kinds', arr(c['resourceKindId']).map((id) => reader.kind(id)).filter(Boolean).join(','));
      break;
    case 'LogAnalysis': {
      const chart = str(c['chartType']);
      if (chart && chart !== 'column') set('chart', chart);
      const show = str(c['liViewMode']);
      if (show && show !== 'all') set('show', show);
      const rel = inner(c['relationshipMode'], 'relationshipMode');
      if (rel === 0) set('relationship', 'self');
      if (rel === -1) set('relationship', 'children');
      set('query', value(str(arr(c['queryFilter_searchtext'])[0])));
      const rows = numOf(inner(c['queryFilter'], 'size'));
      if (rows !== undefined && rows !== 50) set('rows', rows);
      break;
    }
    case 'Forensics':
    case 'WeatherMap':
      set('kind', reader.kind(c['resourceKindId']));
      set('metric', str(c['metricKey']));
      if (typeof c['periodLength'] === 'string') set('period', c['periodLength']);
      break;
    default:
      if (type.family === 'badge' && type.type.startsWith('IntSummary')) {
        if (type.settings.some((x) => x.key === 'badge') && inner(c['badgeMode'], 'badgeMode') === true) set('badge', 'yes');
        pinned();
      }
      break;
  }
  // The settings that read themselves back (the newer options, the filter, the objects, the 9.x keys).
  const source = { config: c, widget, entries: reader.entries, kind: (id         ) => reader.kind(id) };
  for (const setting of type.settings) {
    if (s[setting.key] !== undefined || !setting.read) continue;
    set(setting.key, setting.read(source));
  }
  if (widget['collapsed'] === true) set('collapsed', 'yes');
  // Only keys this type takes, so a row never reads as a mistake of the loader's.
  const known = new Set(type.settings.map((x) => x.key));
  return Object.fromEntries(Object.entries(s).filter(([key]) => known.has(key)));
}

/** "key=value; key=value", with text= and html= last because they take the rest of the cell. */
export function settingsText(settings                        )         {
  const entries = Object.entries(settings);
  const rest = entries.filter(([key]) => key === 'text' || key === 'html');
  return [...entries.filter(([key]) => key !== 'text' && key !== 'html'), ...rest].map(([key, v]) => `${key}=${v}`).join('; ');
}

// ---------------------------------------------------------------------------
// A whole dashboard into the builder's values
// ---------------------------------------------------------------------------

const REFRESHES = [60, 120, 300, 600, 900, 1800, 3600];

/** The context a widget is built in, the same one the dashboard blueprint uses. */
export function widgetContext(options                                                                                                                                              )                {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return {
    id: options.id,
    title: options.title,
    selfProvider: options.selfProvider,
    refreshInterval: options.refreshInterval,
    refreshContent: options.refreshContent,
    s: options.settings,
    entries: options.entries,
    viewId: (view) => (uuid.test(view) ? view : stableId(`view:${view}`)),
  };
}

                                  
                                                      
                                                             
                              
                                                                            
                           
 

/**
 * Read one dashboard of an export into the builder: rows for the widgets it
 * understands (and verbatim rows for the ones it does not), the dashboard
 * options, and the export itself, kept whole.
 */
export function loadDashboard(exp                    , dashboardIndex        , others                                = [], viewDefs                              = new Map())                  {
  const dashboard = arr(exp.json['dashboards'])[dashboardIndex];
  if (!isObj(dashboard)) throw new Error('That dashboard is not in the file.');
  const entries = Entries.seeded(exp.json['entries']);
  const reader         = {
    entries,
    kind: (id) => {
      const ref = typeof id === 'string' ? entries.kindOf(id) : undefined;
      return ref ? kindAlias(ref) : undefined;
    },
  };
  const widgets = arr(dashboard['widgets']).filter(isObj);
  const notes           = [];

  // The dashboard's refresh: the most common among its widgets, when it is one the form offers.
  const intervals = widgets.map((w) => numOf(inner(w['config'], 'refreshInterval'))).filter((n)              => n !== undefined);
  const counts = new Map                ();
  for (const n of intervals) counts.set(n, (counts.get(n) ?? 0) + 1);
  const common = [...counts.entries()].filter(([n]) => REFRESHES.includes(n)).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 300;
  const contents = widgets.map((w) => inner(inner(w['config'], 'refreshContent'), 'refreshContent')).filter((v) => typeof v === 'boolean');
  const refreshContent = contents.filter((v) => v === false).length <= contents.length / 2;

  // Titles: unique and on one line, because "Receives from" finds a widget by title.
  const used = new Set        ();
  const titles = new Map                ();
  widgets.forEach((w, index) => {
    const type = widgetType(str(w['type']));
    let title = cell(str(w['title'])) || `${type?.label ?? (str(w['type']) || 'Widget')} ${index + 1}`;
    if (used.has(title.toLowerCase())) {
      let n = 2;
      while (used.has(`${title} (${n})`.toLowerCase())) n += 1;
      title = `${title} (${n})`;
    }
    used.add(title.toLowerCase());
    titles.set(str(w['id']), title);
  });

  // Interactions: the first sender of each receiver becomes "Receives from"; the rest are kept as they are.
  const receives = new Map                ();
  let extraInteractions = 0;
  for (const link of arr(dashboard['widgetInteractions']).filter(isObj)) {
    const receiver = str(link['widgetIdReceiver']);
    const provider = str(link['widgetIdProvider']);
    const senderType = widgetType(str(widgets.find((w) => str(w['id']) === provider)?.['type']));
    if (!titles.has(receiver) || !titles.has(provider) || receives.has(receiver) || receiver === provider || senderType?.provides === false) {
      extraInteractions += 1;
      continue;
    }
    receives.set(receiver, titles.get(provider) );
  }
  if (extraInteractions > 0) notes.push(`${extraInteractions} widget interaction${extraInteractions === 1 ? '' : 's'} beyond one sender per widget ${extraInteractions === 1 ? 'is' : 'are'} kept exactly as exported.`);

  const rows                           = {};
  const kept                           = {};
  const lines           = [];
  const seenIds = new Set        ();
  for (const w of widgets) {
    let id = str(w['id']);
    if (!id || seenIds.has(id)) {
      notes.push(`A widget with ${id ? 'a repeated' : 'no'} id ("${str(w['title'])}") is given its own id.`);
      id = stableId(`loaded-widget:${seenIds.size}:${str(w['title'])}`);
    }
    seenIds.add(id);
    const known = widgetType(str(w['type']));
    const type = known ?? passthroughType(w);
    const config = isObj(w['config']) ? w['config'] : {};
    const title = titles.get(str(w['id'])) ?? str(w['title']);
    const from = receives.get(str(w['id'])) ?? '';
    const self = inner(config['selfProvider'], 'selfProvider') === true;
    const settings = known ? settingsFromConfig(known, config, reader, w) : {};
    const interval = numOf(config['refreshInterval']);
    const content = inner(config['refreshContent'], 'refreshContent');
    if (known && type.settings.some((x) => x.key === 'refresh')) {
      if (content === false && refreshContent) settings['refresh'] = 'off';
      else if (interval !== undefined && interval !== common) settings['refresh'] = String(interval);
    }
    const coords = isObj(w['gridsterCoords']) ? w['gridsterCoords'] : {};
    const xywh = ['x', 'y', 'w', 'h'].map((k) => numOf(coords[k]) ?? numOf(w[k]));
    const position = xywh.every((n) => n !== undefined && Number.isInteger(n) && n > 0) ? xywh.join(',') : 'auto';
    const cells           = [type.type, title, settingsText(settings), position, self && !from ? 'yes' : 'no', from];
    rows[id] = cells;
    lines.push([...cells, id].join(' | '));

    // What the rows cannot say, found by building the row and comparing with the export.
    const why           = [];
    if (!known) why.push(`${type.type} is a widget type the builder does not know; the whole widget is kept as exported`);
    else {
      const scratch = Entries.seeded(exp.json['entries']);
      const selfProvider = cells[4] === 'yes' && !from;
      const rowRefresh = settings['refresh'] ?? '';
      const built = known.build(
        widgetContext({
          id,
          title: str(w['title']),
          selfProvider,
          refreshInterval: /^\d+$/.test(rowRefresh) ? Number(rowRefresh) : common,
          refreshContent: /^off$/i.test(rowRefresh) ? false : refreshContent,
          settings: new Settings(cells[2]),
          entries: scratch,
        }),
      );
      const differ = [...new Set([...Object.keys(config), ...Object.keys(built)])].filter((key) => !(known.type === 'Section' && key === 'widgets') && !deepEqual(config[key], built[key]));
      if (differ.length > 0) why.push(`config keys kept exactly as exported: ${differ.join(', ')}`);
    }
    if (position === 'auto') why.push('its position is not x,y,w,h on the grid, so the exported one is kept until it is moved');
    if (title !== str(w['title'])) why.push(`its title is shown as "${title}" (the exported title "${str(w['title'])}" is kept unless it is renamed)`);
    if (self && from) why.push('it provides for itself and also receives; both are kept as exported');
    const extras = Object.keys(w).filter((k) => !['id', 'type', 'title', 'collapsed', 'gridsterCoords', 'config'].includes(k));
    if (extras.length > 0) why.push(`widget keys kept as exported: ${extras.join(', ')}`);
    if (why.length > 0) kept[id] = why;
  }

  // Navigations: to a dashboard in the same file by name; to one known only by id, kept as it is.
  const names = new Map                ();
  for (const e of [exp, ...others]) for (const d of arr(e.json['dashboards']).filter(isObj)) names.set(str(d['id']), str(d['name']));
  const navLines           = [];
  let keptNavs = 0;
  const navs = isObj(dashboard['dashboardNavigations']) ? dashboard['dashboardNavigations'] : {};
  for (const [from, list] of Object.entries(navs)) {
    const title = titles.get(from);
    const fromType = widgetType(str(widgets.find((w) => str(w['id']) === from)?.['type']));
    for (const target of arr(list)) {
      const name = names.get(str(inner(target, 'id')));
      if (title && fromType?.provides && name && name !== str(dashboard['name']) && !/->|→/.test(name) && !/->|→/.test(title)) navLines.push(`${title} -> ${name}`);
      else keptNavs += 1;
    }
  }
  if (keptNavs > 0) notes.push(`${keptNavs} navigation${keptNavs === 1 ? '' : 's'} to another dashboard ${keptNavs === 1 ? 'is' : 'are'} kept exactly as exported (the target is known only by its id).`);

  const name = str(dashboard['name']);
  const namePath = str(dashboard['namePath']).replace(/^\/+|\/+$/g, '');
  const inFolder = namePath && name.startsWith(`${namePath}/`);
  const states = arr(dashboard['states']).filter(isObj);
  const timeState = states.find((st) => str(st['key']).startsWith('permDashboardTime_dashboard_'));
  const timeRange = Object.entries(DASHBOARD_TIME_RANGES).find(([, v]) => v === str(timeState?.['value']))?.[0] ?? 'none';
  if (timeState && timeRange === 'none') notes.push('The dashboard time range is one the form does not offer; it is kept as exported.');
  const delay = numOf(dashboard['autoswitchDelay']);
  const extraKeys = Object.keys(dashboard).filter((k) => !DASHBOARD_KEYS[k]?.field && !['temporary', 'columnCount', 'gridsterMaxColumns', 'rank', 'creationTime', 'lastUpdateTime', 'importAttempts', 'importComplete', 'userId', 'lastUpdateUserId'].includes(k));
  if (extraKeys.length > 0) notes.push(`Dashboard keys kept as exported: ${extraKeys.join(', ')}.`);
  notes.push('The owner, creation time and every other dashboard key are kept as exported.');

  const values                                            = {
    template: 'custom',
    widgets_custom: lines.join('\n'),
    dashboard_name: cell(inFolder ? name.slice(namePath.length + 1) : name),
    folder: inFolder ? namePath : '',
    description: cell(str(dashboard['description'])),
    sharing: dashboard['shared'] === false ? 'private' : 'everyone',
    refresh: String(common),
    refresh_content: refreshContent,
    time_range: timeRange,
    home_tab: dashboard['homeTab'] === true,
    locked: dashboard['locked'] === true,
    hidden: dashboard['hidden'] === true,
    disabled: dashboard['disabled'] === true,
    column_proportion: COLUMN_PROPORTIONS.some((c) => c.value === str(dashboard['columnProportion'])) ? str(dashboard['columnProportion']) : '1',
    autoswitch: dashboard['autoswitchEnabled'] === true,
    autoswitch_delay: delay !== undefined && delay >= 5 && delay <= 3600 ? delay : 300,
    navigations: navLines.join('\n'),
    max_widgets: Math.min(40, Math.max(10, widgets.length)),
  };
  const top      = {};
  for (const [key, v] of Object.entries(exp.json)) if (key !== 'entries' && key !== 'dashboards') top[key] = v;
  // The views the file holds that this dashboard's View widgets show: kept, and written back beside it.
  const views                         = {};
  for (const w of widgets) {
    const id = str(inner(w['config'], 'viewDefinitionId'));
    if (str(w['type']) === 'View' && viewDefs.has(id)) views[id] = viewDefs.get(id) ;
  }
  if (Object.keys(views).length > 0) notes.push(`${Object.keys(views).length} view${Object.keys(views).length === 1 ? '' : 's'} its View widgets show ${Object.keys(views).length === 1 ? 'was' : 'were'} in the file too, and ${Object.keys(views).length === 1 ? 'is' : 'are'} written back in import/views.zip.`);
  const store              = { version: 1, file: exp.file, top, entries: exp.json['entries'] ?? { resourceKind: [], resource: [] }, dashboard, values, rows, kept, notes, ...(Object.keys(views).length > 0 ? { views } : {}) };
  const keptWidgets = Object.keys(kept).length;
  const summary = `Loaded "${name}" from ${exp.file}: ${widgets.length} widget${widgets.length === 1 ? '' : 's'}${keptWidgets > 0 ? `, ${keptWidgets} with parts kept exactly as exported` : ''}.`;
  return { values: { ...values, imported: JSON.stringify(store) }, store, summary };
}

// ---------------------------------------------------------------------------
// Writing it back
// ---------------------------------------------------------------------------

                
                        
                                    
                                    
 

/**
 * The dashboard to write: the exported one, changed by what differs between
 * the builder's output for the loaded values (base) and for the values now
 * (next). Widgets are matched by id, interactions by their two ends.
 */
export function mergeDashboard(store             , base     , next     )      {
  const original = store.dashboard;
  const out      = clone(original);
  for (const key of new Set([...Object.keys(base), ...Object.keys(next)])) {
    if (key === 'widgets' || key === 'widgetInteractions') continue;
    if (!(key in next)) delete out[key];
    else out[key] = merge3(original[key], base[key], next[key]);
  }

  const byId = (list      )                   => new Map(arr(list).filter(isObj).map((w) => [str(w['id']), w]));
  const originals = byId(original['widgets']);
  const bases = byId(base['widgets']);
  const widgets = arr(next['widgets'])
    .filter(isObj)
    .map((widget) => {
      const id = str(widget['id']);
      const was = originals.get(id);
      const baseWidget = bases.get(id);
      return was && baseWidget ? (merge3(was, baseWidget, widget)       ) : clone(widget);
    });
  out['widgets'] = widgets;
  const present = new Set(widgets.map((w) => str(w['id'])));
  // Only a widget that was in the export and has been removed takes its links with it; a link the export
  // already held to no widget at all is kept as it was.
  const gone = (id        )          => originals.has(id) && !present.has(id);

  const key = (link      )         => `${str(inner(link, 'widgetIdProvider'))}\u0000${str(inner(link, 'widgetIdReceiver'))}`;
  const baseLinks = new Map(arr(base['widgetInteractions']).filter(isObj).map((l) => [key(l), l                   ]));
  const nextLinks = new Map(arr(next['widgetInteractions']).filter(isObj).map((l) => [key(l), l                   ]));
  const kept = arr(original['widgetInteractions'])
    .filter(isObj)
    .filter((link) => !gone(str(link['widgetIdProvider'])) && !gone(str(link['widgetIdReceiver'])))
    .filter((link) => !(baseLinks.has(key(link)) && !nextLinks.has(key(link))))
    .map((link) => {
      const b = baseLinks.get(key(link));
      const n = nextLinks.get(key(link));
      return b && n && b.type !== n.type ? { ...clone(link), type: n.type } : clone(link);
    });
  const keptKeys = new Set(kept.map(key));
  const added = [...nextLinks.entries()].filter(([k]) => !baseLinks.has(k) && !keptKeys.has(k)).map(([, link]) => clone(link));
  const links = [...kept, ...added];
  if (links.length > 0 || 'widgetInteractions' in original) out['widgetInteractions'] = links;

  // A navigation from a widget that is gone goes with it.
  if (isObj(out['dashboardNavigations'])) {
    for (const from of Object.keys(out['dashboardNavigations'])) if (gone(from)) delete out['dashboardNavigations'][from];
  }
  return out;
}

/** Every entries id the dashboard refers to. */
export function referencedEntries(dashboard      )              {
  return new Set(JSON.stringify(dashboard).match(/resource(?:Kind)?:id:\d+_::_/g) ?? []);
}

/** A loaded row's cells as they stand now, to compare with how it was loaded. */
export function sameRow(a          , b                   )          {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && (a[4] || 'no').toLowerCase() === (b[4] || 'no').toLowerCase() && a[5] === b[5];
}

                        
