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
 *          Alert and Troubleshoot, ESX Host Details, VM Details v4 …).
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
export const WORLDS                                                                             = {
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
                   kinds = new Map                                                                                                ();
                   resources = new Map                                                                                                                       ();
          nextKind = 0;
          nextResource = 0;

  /**
   * Start from the entries table of a loaded export: its ids are kept, an
   * object type or object it already lists is found under its own id, and a
   * new one is numbered after the highest there. The entries are written back
   * exactly as the export had them.
   */
  static seeded(json         )          {
    const entries = new Entries();
    const record = (value         )                                   => typeof value === 'object' && value !== null && !Array.isArray(value);
    const table = record(json) ? json : {};
    const index = (id        )         => Number(/:id:(\d+)_::_$/.exec(id)?.[1] ?? -1);
    for (const raw of Array.isArray(table['resourceKind']) ? table['resourceKind'] : []) {
      if (!record(raw) || typeof raw['internalId'] !== 'string') continue;
      const ref = { adapterKind: String(raw['adapterKindKey'] ?? ''), resourceKind: String(raw['resourceKindKey'] ?? '') };
      const key = `${ref.adapterKind}\u0000${ref.resourceKind}`;
      const entry = { ref, id: raw['internalId'], raw };
      entries.kinds.set(entries.kinds.has(key) ? `${key}\u0000${raw['internalId']}` : key, entry);
      entries.nextKind = Math.max(entries.nextKind, index(raw['internalId']) + 1);
    }
    for (const raw of Array.isArray(table['resource']) ? table['resource'] : []) {
      if (!record(raw) || typeof raw['internalId'] !== 'string') continue;
      const ref = { adapterKind: String(raw['adapterKindKey'] ?? ''), resourceKind: String(raw['resourceKindKey'] ?? '') };
      const name = String(raw['name'] ?? '');
      const key = `${ref.adapterKind}\u0000${ref.resourceKind}\u0000${name}`;
      entries.resources.set(entries.resources.has(key) ? `${key}\u0000${raw['internalId']}` : key, { ref, name, id: raw['internalId'], raw });
      entries.nextResource = Math.max(entries.nextResource, index(raw['internalId']) + 1);
    }
    return entries;
  }

  kind(ref         )         {
    const key = `${ref.adapterKind}\u0000${ref.resourceKind}`;
    const found = this.kinds.get(key);
    if (found) return found.id;
    const id = `resourceKind:id:${this.nextKind}_::_`;
    this.nextKind += 1;
    this.kinds.set(key, { ref, id });
    return id;
  }

  resource(ref         , name        )         {
    const key = `${ref.adapterKind}\u0000${ref.resourceKind}\u0000${name}`;
    const found = this.resources.get(key);
    if (found) return found.id;
    const id = `resource:id:${this.nextResource}_::_`;
    this.nextResource += 1;
    this.resources.set(key, { ref, name, id });
    return id;
  }

  /** The object type an entries id stands for. */
  kindOf(id        )                      {
    for (const entry of this.kinds.values()) if (entry.id === id) return entry.ref;
    return undefined;
  }

  /** The object an entries id stands for. */
  resourceOf(id        )                                                               {
    for (const entry of this.resources.values()) if (entry.id === id) return { ref: entry.ref, name: entry.name };
    return undefined;
  }

  /**
   * The table as an export writes it. With `keep`, only the entries it says
   * to: a loaded export's own entries are always kept, a new one only when
   * the dashboard refers to it.
   */
  toJson(keep                                           )                                                                                   {
    const wanted = (id        , loaded         )          => (keep ? keep(id, loaded) : true);
    return {
      resourceKind: [...this.kinds.values()].filter((entry) => wanted(entry.id, !!entry.raw)).map((entry) => entry.raw ?? { adapterKindKey: entry.ref.adapterKind, internalId: entry.id, resourceKindKey: entry.ref.resourceKind }),
      resource: [...this.resources.values()]
        .filter((entry) => wanted(entry.id, !!entry.raw))
        .map((entry) => entry.raw ?? { adapterKindKey: entry.ref.adapterKind, identifiers: [], internalId: entry.id, name: entry.name, resourceKindKey: entry.ref.resourceKind }),
    };
  }
}

// ---------------------------------------------------------------------------
// Settings: "kind=cluster; metrics=cpu|usage_average,mem|usage_average; top=10"
// ---------------------------------------------------------------------------

/**
 * How a setting is edited: kind(s) are object types, metric(s) metric keys,
 * choice(s) closed sets (a dropdown, or ticks for several), yesno a switch,
 * text free text (with suggestions when it has options), rest text that takes
 * the rest of the cell, colors #rrggbb lists, filter Output Filter rules,
 * objects "type:Name" pairs.
 */
                                                                                                                                                                              

/** What a setting's reader gets: the loaded config, the widget, and the entries to name object types by. */
                                
                                           
                                           
                            
                                                                           
                                        
 

                                
                       
                             
                        
                              
                                                                            
                                       
                        
                        
                                                                                                      
                          
                                                          
                        
                                                                     
                            
                                   
                                      
     
                                                                               
                                                
     
                                
     
                                                                              
                                                                              
                                                                             
     
                                  
                                                                                                  
                                                                
 

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

// ---------------------------------------------------------------------------
// Pieces of config many widgets share: the Output Filter, chosen objects,
// relationship mode, metric units
// ---------------------------------------------------------------------------

/** The object type a kindId ("002006VMWAREVirtualMachine") stands for. */
export function kindFromId(id        )                      {
  const m = /^0020(\d\d)(.+)$/.exec(id);
  if (!m) return undefined;
  const len = Number(m[1]);
  if (m[2] .length <= len) return undefined;
  return { adapterKind: m[2] .slice(0, len), resourceKind: m[2] .slice(len) };
}

/** Conditions an Output Filter rule takes, as exports write them (EXISTS carries a value of 0). */
export const FILTER_CONDITIONS = ['EQUALS', 'NOT_EQUALS', 'GREATER_THAN', 'LESS_THAN', 'CONTAINS', 'NOT_CONTAINS', 'EXISTS']         ;
/** Relationship rules of an Output Filter: how the named object is related. */
export const FILTER_RELATIONS = ['CHILD', 'DESCENDANT']         ;

                             
                                                                 
                                                                                              
                       
                             
                         
 

/**
 * filter= rules, joined by " & ":
 *   metric cpu|usage_average GREATER_THAN 80
 *   property summary|tag CONTAINS Production
 *   name NOT_EQUALS vc-01
 *   relationship DESCENDANT EQUALS SDDC Health
 */
export function parseFilter(text        )                                              {
  const rules               = [];
  const problems           = [];
  const conditions = new Set        (FILTER_CONDITIONS);
  for (const raw of text.split(/\s+&\s+/).map((part) => part.trim()).filter(Boolean)) {
    const words = raw.split(/\s+/);
    const kind = words[0]?.toLowerCase();
    if (kind === 'metric' || kind === 'property') {
      const [, key = '', condition = '', ...rest] = words;
      if (!key || !conditions.has(condition.toUpperCase())) problems.push(`"${raw}" is not ${kind} <key> <condition> <value>`);
      else rules.push({ kind, key, condition: condition.toUpperCase(), value: rest.join(' ') });
    } else if (kind === 'name') {
      const [, condition = '', ...rest] = words;
      if (!conditions.has(condition.toUpperCase())) problems.push(`"${raw}" is not name <condition> <value>`);
      else rules.push({ kind, key: '', condition: condition.toUpperCase(), value: rest.join(' ') });
    } else if (kind === 'relationship') {
      const [, relation = '', condition = '', ...rest] = words;
      if (!(FILTER_RELATIONS                     ).includes(relation.toUpperCase()) || !conditions.has(condition.toUpperCase())) problems.push(`"${raw}" is not relationship <${FILTER_RELATIONS.join('|')}> <condition> <object name>`);
      else rules.push({ kind, key: relation.toUpperCase(), condition: condition.toUpperCase(), value: rest.join(' ') });
    } else problems.push(`"${raw}" does not start with metric, property, name or relationship`);
  }
  return { rules, problems };
}

/** The customFilter block (the widget's Output Filter, Advanced), as exports write it. */
function customFilterOf(ctx               , fallbackKind          )         {
  const { rules } = parseFilter(ctx.s.get('filter'));
  if (rules.length === 0) return EMPTY_FILTER;
  const kind = ctx.s.kind('filterkind') ?? fallbackKind;
  const filterTypes = rules.map((rule)         => {
    if (rule.kind === 'name') return { condition: rule.condition, resourceName: rule.value, filterType: 'resourceName' };
    if (rule.kind === 'relationship') return { condition: rule.condition, traversalSpec: null, relValue: rule.value, relType: rule.key, filterType: 'relationship' };
    const isString = rule.kind === 'property';
    const numeric = Number(rule.value === '' ? 0 : rule.value);
    return { condition: rule.condition, metricKey: rule.key, metricValue: { isStringMetric: isString, value: isString || !Number.isFinite(numeric) ? rule.value : numeric }, filterType: isString ? 'properties' : 'metrics' };
  });
  return { filter: [{ resourceKind: kind ? kindId(kind) : null, filterTypes }], excludedResources: null, includedResources: null };
}

/** filterMode as exports write it: the Advanced (customFilter) tab when filter= is set, the tag tree otherwise. */
function filterModeOf(ctx               )         {
  return ctx.s.has('filter') ? 'customFilter' : 'tagPicker';
}

/** filter= back from a customFilter block; undefined when it holds more than one group or a rule the text cannot say. */
export function filterText(block         )                                                 {
  const rec = (v         )                               => typeof v === 'object' && v !== null && !Array.isArray(v);
  if (!rec(block) || !Array.isArray(block['filter'])) return undefined;
  if (block['filter'].length === 0) return { filter: '' };
  if (block['filter'].length > 1) return undefined;
  const group = block['filter'][0];
  if (!rec(group) || !Array.isArray(group['filterTypes']) || Object.keys(group).some((k) => k !== 'resourceKind' && k !== 'filterTypes')) return undefined;
  const parts           = [];
  const text = (v         )                     => {
    const out = String(v ?? '');
    return /[;,\n]|\s&\s|^\s|\s$/.test(out) ? undefined : out;
  };
  for (const t of group['filterTypes']) {
    if (!rec(t)) return undefined;
    const cond = String(t['condition'] ?? '');
    if (!(FILTER_CONDITIONS                     ).includes(cond)) return undefined;
    if (t['filterType'] === 'resourceName' && Object.keys(t).length === 3) {
      const v = text(t['resourceName']);
      if (v === undefined) return undefined;
      parts.push(`name ${cond} ${v}`.trim());
    } else if (t['filterType'] === 'relationship' && t['traversalSpec'] === null && Object.keys(t).length === 5 && (FILTER_RELATIONS                     ).includes(String(t['relType']))) {
      const v = text(t['relValue']);
      if (v === undefined) return undefined;
      parts.push(`relationship ${String(t['relType'])} ${cond} ${v}`.trim());
    } else if ((t['filterType'] === 'metrics' || t['filterType'] === 'properties') && rec(t['metricValue']) && Object.keys(t).length === 4) {
      const v = text(t['metricValue']['value']);
      if (v === undefined || typeof t['metricKey'] !== 'string' || /\s/.test(t['metricKey'])) return undefined;
      parts.push(`${t['filterType'] === 'metrics' ? 'metric' : 'property'} ${t['metricKey']} ${cond} ${v}`.trim());
    } else return undefined;
  }
  const kind = typeof group['resourceKind'] === 'string' ? kindFromId(group['resourceKind']) : undefined;
  return { filter: parts.join(' & '), ...(kind ? { kind } : {}) };
}

/** objects= "alias:Name" or "Adapter/Kind:Name" items, for a widget whose Input Data is objects picked by name. */
function objectsOf(ctx               )                                 {
  return ctx.s.list('objects').flatMap((item) => {
    const colon = item.indexOf(':');
    const ref = colon > 0 ? parseKind(item.slice(0, colon)) : undefined;
    const name = colon > 0 ? item.slice(colon + 1).trim() : '';
    return ref && name ? [{ id: ctx.entries.resource(ref, name), name }] : [];
  });
}

/** The relationship modes a widget's Mode row offers: the object itself, its children, its parents. */
export const RELATIONSHIPS                                   = { self: 0, children: -1, parents: 1 };

/** relationship= as the widget writes it: one value as a number, several as a list; a type that writes a list always does. */
function relationshipOf(ctx               , fallback                            )                    {
  const chosen = ctx.s.list('relationship').map((r) => RELATIONSHIPS[r.toLowerCase()]).filter((n)              => n !== undefined);
  if (chosen.length === 0) return Array.isArray(fallback) ? [...fallback] : (fallback          );
  return Array.isArray(fallback) || chosen.length > 1 ? chosen : chosen[0] ;
}

/** relationship= back from relationshipMode: a number or a list of them. */
export function relationshipText(mode         )                     {
  const names = Object.fromEntries(Object.entries(RELATIONSHIPS).map(([k, v]) => [v, k]));
  const list = Array.isArray(mode) ? mode : [mode];
  const out = list.map((n) => (typeof n === 'number' ? names[n] : undefined));
  return out.length > 0 && out.every(Boolean) ? out.join(',') : undefined;
}

/**
 * Metric units as metricUnit {metricUnitId, metricUnitName} and a metric
 * row's metricUnitId/unit carry them (every pair here is one a dashboard
 * export holds). No unit is the -1 the Top-N ("Auto") and the Health Chart
 * ("Default Unit") write.
 */
export const METRIC_UNITS                                   = {
  percent: '%',
  msec: 'ms',
  kb: 'KB',
  gb: 'GB',
  tb: 'TB',
  kbps: 'KBps',
  mbps: 'MBps',
  gbitsps: 'Gbps',
  ghz: 'GHz',
  kwh: 'KWh',
  day: 'Day(s)',
  currency: 'US$',
  currencymonth: 'US$/Month',
};

/** metricUnit for unit=, or the type's own "no unit" entry. */
function unitOf(ctx               , none        )         {
  const unit = ctx.s.get('unit');
  return METRIC_UNITS[unit] ? { metricUnitId: unit, metricUnitName: METRIC_UNITS[unit] } : { metricUnitId: -1, metricUnitName: none };
}

const THRESHOLD_HELP = 'three numbers: yellow,orange,red';

/**
 * One `resourceKindMetrics[]` entry, as the 9.x renderer writes it: colour by
 * the three bounds (colorMethod 0) when thresholds are given, otherwise
 * dynamic colouring (2); `label` is what the tile or row shows.
 */
function metricEntry(ctx               , kind         , key        , label        , seq        , bounds                   , isString = false)         {
  const thresholds = bounds.length === 3;
  const unit = ctx.s.get('unit');
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
    link: ctx.s.get('link'),
    maxValue: ctx.s.has('max') ? String(ctx.s.num('max', 100)) : '',
    metricUnitId: METRIC_UNITS[unit] ? unit : null,
    unit: METRIC_UNITS[unit] ?? null,
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

/** additionalColumns on an Object List or Top-N: extra metric columns beside the name, labelled by columnlabels=. */
function extraColumns(ctx               , kind         , keys                   )           {
  const labels = ctx.s.list('columnlabels');
  return keys.map((key, index) => ({ boxLabel: labels[index] || key, metricKey: key, metricName: key, resourceKindId: ctx.entries.kind(kind) }));
}

/** objectmetrics= "type:Object name=metric|key" items: metrics of objects picked by name (a Metric Chart's resourceMetrics). */
function objectMetricsOf(ctx               )           {
  return ctx.s.list('objectmetrics').flatMap((item) => {
    const eq = item.lastIndexOf('=');
    const colon = item.indexOf(':');
    if (eq < 0 || colon < 0 || colon > eq) return [];
    const ref = parseKind(item.slice(0, colon));
    const name = item.slice(colon + 1, eq).trim();
    const key = item.slice(eq + 1).trim();
    return ref && name && key ? [{ metricKey: key, metricName: key, resourceId: ctx.entries.resource(ref, name), resourceName: name }] : [];
  });
}

/** Time ranges a widget's periodLength takes (Scoreboard, Health Chart, Forensics, Weather Map), as exports write them. */
export const PERIODS = ['dashboardTime', 'lastHour', 'last6Hour', 'last12Hour', 'last24Hour', 'last7Days', 'last30Days', 'last90Days', 'lastYear']         ;

/** A Top-N's periodLength is an object: the range and the text the picker showed (every pair here is from an export). */
export const TOPN_PERIODS                                   = { currentValue: 'Current Value', last24Hour: 'Last 24 hours', last30Days: 'Last 30 days' };

/** Alert subtypes as the Alert List's type codes carry them, `<type>_<subtype>`, types 15 to 20 (BP and QA92 exports). */
export const ALERT_SUBTYPES                                   = { availability: 18, performance: 19, capacity: 20, compliance: 21, configuration: 22 };
export const CRITICALITY                                   = { info: 1, warning: 2, immediate: 3, critical: 4 };

export const SCOREBOARD_THEMES = ['original', 'solid', 'default', 'simple', 'pastel', 'shadow', 'outline', 'gradient', 'gauge']         ;

/** Top-N analyses: the row's order= and the topOption each writes (all in exports: topOption, or tagOption for the health ones). */
export const TOPN_ORDERS                                   = {
  highest: 'metricsHighestUtilization',
  lowest: 'metricsLowestUtilization',
  'least-healthy': 'leastHealthyApplications',
  'most-healthy': 'mostHealthyApplications',
  'most-alarming': 'mostAlarmingResources',
};

// ---------------------------------------------------------------------------
// The catalogue
// ---------------------------------------------------------------------------

                                                                                                                        

                             
                                       
                        
                                                    
                         
                                
                                                                   
                             
                                                                                    
                          
                                                         
                         
                                               
                                
                                                                      
                        
                                                                                                            
                                       
                                                                                
                             
                                                                          
                                 
                                       
                                                            
                                              
     
                                                                            
                                                                 
     
                                                          
                                                                                          
                                                         
                                                 
 

/** Config keys the row itself writes, not a setting: its title, Provider, and the refresh. */
export const ROW_KEYS                                   = {
  title: 'the row’s Title',
  titleLocalized: 'the row’s Title (the text the editor localizes)',
  refreshInterval: 'refresh= on the row, or the dashboard’s refresh',
  refreshContent: 'refresh=off on the row, or the dashboard’s "refresh their data"',
  selfProvider: 'the row’s Provider',
};

const DOCS91 = 'https://techdocs.broadcom.com/us/en/vmware-cis/vcf/vcf-9-0-and-later/9-1/infrastructure-operations/dashboards-and-widgets/using-widgets/widget-definitions-list/';
const DOCS90 = 'https://techdocs.broadcom.com/us/en/vmware-cis/vcf/vcf-9-0-and-later/9-0/infrastructure-operations/dashboards-and-widgets/using-widgets/widget-definitions-list/';
/** The Broadcom page of a widget in the 9.1 widget definitions list. */
const doc = (page        )         => `${DOCS91}${page}.html`;
/** The Configuration Files page: Metric Configuration XML files. */
const METRIC_CONFIG_DOC = 'https://techdocs.broadcom.com/us/en/vmware-cis/vcf/vcf-9-0-and-later/9-1/infrastructure-operations/dashboards-and-widgets/using-widgets/configuration-files.html';

// Readers: a setting back from the loaded config, or undefined when it holds the default.
                                                          
const rec = (v         )                               => typeof v === 'object' && v !== null && !Array.isArray(v);
const at = (config                         , key        , inner         )          => (inner === undefined ? config[key] : rec(config[key]) ? (config[key]                           )[inner] : undefined);
/** A yes/no kept as {key: {inner: bool}} or {key: bool}. */
const readFlag = (key        , inner                    , fallback         )       => (src) => {
  const v = at(src.config, key, inner);
  return typeof v === 'boolean' && v !== fallback ? (v ? 'yes' : 'no') : undefined;
};
const readNum = (key        , fallback               , inner         )       => (src) => {
  const v = at(src.config, key, inner);
  return typeof v === 'number' && Number.isFinite(v) && v !== fallback ? String(v) : undefined;
};
const cellText = (text        )                     => (/[;\n\r\t]|\s\|\s/.test(text) ? undefined : text.trim() || undefined);
const readText = (key        , fallback = '', inner         )       => (src) => {
  const v = at(src.config, key, inner);
  return typeof v === 'string' && v !== fallback ? cellText(v) : undefined;
};
const readChoice = (key        , options                   , fallback        , inner         )       => (src) => {
  const v = at(src.config, key, inner);
  return typeof v === 'string' && v !== fallback && options.includes(v) ? v : undefined;
};
const readRelationship = (fallback        )       => (src) => {
  const text = relationshipText(at(src.config, 'relationshipMode', 'relationshipMode'));
  return text && text !== fallback ? text : undefined;
};
const readFilter       = (src) => {
  const f = filterText(src.config['customFilter']);
  return f?.filter || undefined;
};
const readFilterKind       = (src) => {
  const f = filterText(src.config['customFilter']);
  return f?.filter && f.kind ? kindAlias(f.kind) : undefined;
};
const readObjects       = (src) => {
  const list = src.config['resource'];
  if (!Array.isArray(list) || list.length === 0) return undefined;
  const out           = [];
  for (const item of list) {
    const id = rec(item) && 'name' in item ? String(item['id'] ?? '') : '';
    const found = src.entries.resourceOf(id);
    if (!found || /[,;:|]/.test(found.name) || !found.name.trim()) return undefined;
    out.push(`${kindAlias(found.ref)}:${found.name}`);
  }
  return out.join(',');
};
const readUnit = (key = 'metricUnit')       => (src) => {
  const id = at(src.config, key, 'metricUnitId');
  return typeof id === 'string' && METRIC_UNITS[id] ? id : undefined;
};

/** Settings many widgets take, built the same way wherever they appear. */
const S = {
  kind: (required = true, help = 'the object type: cluster, host, vm, datastore … or Adapter/Kind')                => ({ key: 'kind', type: 'kind', required, help, label: 'Object type (Output Data)' }),
  kinds: (required = true, writes                    = ['tagFilter'])                => ({ key: 'kinds', type: 'kinds', required, help: 'object types, comma separated: cluster,host or Adapter/Kind', label: 'Output Filter › Basic (object type)', writes }),
  metrics: (required = true)                => ({ key: 'metrics', type: 'metrics', required, help: 'metric keys, comma separated: cpu|usage_average,mem|usage_average', label: 'Output Data (metrics)', writes: ['metric'] }),
  metric: (required = true, help = 'one metric key: cpu|usage_average')                => ({ key: 'metric', type: 'metric', required, help, label: 'Metric' }),
  labels: { key: 'labels', type: 'text', help: 'box labels for the metrics, comma separated, in the same order', label: 'Box Label', writes: ['metric'] }                 ,
  thresholds: (writes                    = ['metric'])                => ({ key: 'thresholds', type: 'numbers', help: `${THRESHOLD_HELP} (Color Method › Custom)`, label: 'Color Method › Custom', writes }),
  pin: (writes                    = ['resource'])                => ({ key: 'pin', type: 'text', help: 'what a self-providing widget starts from: world (default) or alias:Object name (vm:web-01)', label: 'Input Data › Object', default: 'world', writes }),
  depth: (max = 10, fallback = 1)                => ({ key: 'depth', type: 'number', min: 1, max, help: `how many levels below the object to look (default ${fallback})`, label: 'Input Transformation › Relationship (depth)', default: String(fallback), writes: ['depth'] }),
  period: (help = 'time range the values are taken over')                => ({ key: 'period', type: 'choice', options: PERIODS, help, label: 'Period Length', writes: ['periodLength'] }),
  refresh: { key: 'refresh', type: 'text', help: 'seconds between refreshes, or off (default: the dashboard’s)', label: 'Refresh Interval / Refresh Content', writes: ['refreshInterval', 'refreshContent'] }                 ,
  relationship: (fallback        , docPage        , multi = false)                => ({
    key: 'relationship',
    type: multi ? 'choices' : 'choice',
    options: Object.keys(RELATIONSHIPS),
    help: `the objects the input is turned into: the object itself, its children, its parents (default ${fallback})`,
    label: 'Input Transformation › Relationship',
    doc: doc(docPage),
    default: fallback,
    writes: ['relationshipMode'],
    read: readRelationship(fallback),
  }),
  filter: (docPage        , writes                    = ['customFilter', 'filterMode'])                => ({
    key: 'filter',
    type: 'filter',
    help: 'rules joined by " & ": metric cpu|usage_average GREATER_THAN 80, property summary|tag CONTAINS prod, name CONTAINS web, relationship DESCENDANT EQUALS <object>',
    label: 'Output Filter › Advanced',
    doc: doc(docPage),
    writes,
    read: readFilter,
  }),
  filterkind: (docPage        , writes                    = ['customFilter'])                => ({ key: 'filterkind', type: 'kind', help: 'the object type the Advanced filter applies to (default: the widget’s own)', label: 'Output Filter › Advanced (object type)', doc: doc(docPage), writes, read: readFilterKind }),
  objects: (docPage        , writes                    = ['resource', 'mode'])                => ({
    key: 'objects',
    type: 'objects',
    help: 'Input Data › Objects: objects picked by name, alias:Name comma separated (vm:web-01,host:esx-01); blank means All',
    label: 'Input Data › Objects',
    doc: doc(docPage),
    writes,
    read: readObjects,
  }),
  metricconfig: (_docPage        )                => ({
    key: 'metricconfig',
    type: 'text',
    help: 'the Metric Configuration XML the widget uses when it does not provide for itself (Administration › Configurations)',
    label: 'Metric Configuration',
    doc: METRIC_CONFIG_DOC,
    writes: ['resInteractionMode'],
    read: readText('resInteractionMode'),
    seenElsewhere: 'the Metric Chart, Scoreboard, Sparkline and Property List of the same export (an XML file name)',
  }),
  unit: (key = 'metricUnit', none = 'Auto')                => ({
    key: 'unit',
    type: 'choice',
    options: Object.keys(METRIC_UNITS),
    help: `the unit the value is shown in (default: ${none}, the metric’s own)`,
    label: 'Unit',
    writes: [key],
    read: readUnit(key),
  }),
  group: [
    { key: 'group', type: 'text', help: 'only the members of this custom group', label: 'Output Filter › Basic (custom group)', writes: ['tagFilter'] },
    { key: 'grouptype', type: 'text', help: 'the custom group’s type (default Environment)', label: 'Output Filter › Basic (group type)', default: 'Environment', writes: ['tagFilter'] },
  ]                   ,
};

/** Settings every widget takes, after its own: the widget's place in a section's fold, and the 9.x description and details link. */
const COMMON_TAIL                           = [
  { key: 'collapsed', type: 'yesno', help: 'the widget starts collapsed (default no)', label: 'Collapse (title bar)', default: 'no' },
  {
    key: 'description',
    type: 'text',
    help: 'a tooltip beside the widget name on the dashboard (VCF Operations 9.1)',
    label: 'Widget Description',
    doc: doc('scoreboard-widget'),
    writes: ['description'],
    read: readText('description'),
  },
  {
    key: 'detailsurl',
    type: 'text',
    help: 'where the View Details button at the bottom of the widget goes: /vcf-operations/ui/inventory or a web address (VCF Operations 9.1)',
    label: 'Details URL',
    doc: doc('scoreboard-widget'),
    writes: ['viewDetails'],
    read: readText('viewDetails'),
  },
];

/** The 9.x description and View Details keys, written when set (a 9.2 export writes both on every widget but the summary badges). */
function tail(ctx               , config        )         {
  if (ctx.s.has('description')) config['description'] = ctx.s.get('description');
  if (ctx.s.has('detailsurl')) config['viewDetails'] = ctx.s.get('detailsurl');
  return config;
}

const BLANK_ONLY                           = [S.refresh];

/** Summary badge widgets share one shape (CF survey "IntSummary* family"; BP, NB and QA92 exports). */
function summaryBadge(type        , label        , opts                                                                                                                                                                              )             {
  const withResource = opts.resource !== false;
  return {
    type,
    label,
    family: 'badge',
    verified: opts.verified,
    source: opts.source,
    doc: opts.doc ?? doc(opts.page),
    ...(opts.aliases ? { aliases: opts.aliases } : {}),
    ...(opts.note ? { note: opts.note } : {}),
    ...(opts.deprecated ? { deprecated: true } : {}),
    provides: false,
    needsSubject: true,
    size: { w: 3, h: 4 },
    settings: [
      { ...S.pin(), seenElsewhere: 'the Alert Volume and Health widgets ({resourceId, resourceName})' },
      ...(opts.badgeMode ? [{ key: 'badge', type: 'yesno', help: 'the badge only (yes), or the badge with its trend chart (no, the default)', label: 'Badge Mode', doc: opts.doc ?? doc(opts.page), default: 'no', writes: ['badgeMode'] }                 ] : []),
      S.refresh,
    ],
    build: (ctx) => {
      const pin = pinOf(ctx, undefined);
      return {
        refreshInterval: ctx.refreshInterval,
        ...(withResource || ctx.selfProvider ? { resource: ctx.selfProvider ? { resourceId: ctx.entries.resource(pin.ref, pin.name), resourceName: pin.name } : null } : {}),
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
/** A customer content export (306 dashboards, read for keys and value shapes only). */
const REAL = 'a customer content export read for its shapes (306 dashboards)';
const DOCS = 'Broadcom TechDocs VCF 9.1 "Widget Definitions List" (no export seen)';

const LEGACY_MODE = 'the 8.x editor’s mode ({mode: n} or a number); 9.x writes relationshipMode and a mode string instead';
const UNDEFINED_KEY = 'a key literally named "undefined" that an older editor wrote; it means nothing and is kept as exported';

const RAW_TYPES                        = [
  {
    type: 'ResourceList',
    label: 'Object List',
    family: 'list',
    verified: true,
    source: `${CF} _resource_list_widget; ${NB} (cost_by_application), GaryFlynn/vrops-dashboards-vm-uptime (custom-group filter); ${REAL}`,
    doc: doc('object-list-widget'),
    provides: true,
    needsSubject: false,
    size: { w: 4, h: 6 },
    settings: [
      S.kinds(false),
      ...S.group,
      S.objects('object-list-widget'),
      { key: 'columns', type: 'metrics', help: 'extra metric columns, comma separated', label: 'Additional Columns', doc: doc('object-list-widget'), writes: ['additionalColumns'] },
      { key: 'columnlabels', type: 'text', help: 'labels for the extra columns, comma separated, in the same order (default: the metric key)', label: 'Additional Columns (label)', doc: doc('object-list-widget'), writes: ['additionalColumns'] },
      { key: 'first', type: 'yesno', help: 'select the first row on open (default yes)', label: 'Auto Select First Row', doc: doc('object-list-widget'), default: 'yes', writes: ['selectFirstRow'] },
      S.relationship('self', 'object-list-widget', true),
      S.depth(),
      S.filter('object-list-widget'),
      S.filterkind('object-list-widget'),
      S.refresh,
    ],
    passthrough: {},
    build: (ctx) => {
      const kinds = ctx.s.kinds('kinds');
      const group = ctx.s.get('group');
      const objects = objectsOf(ctx);
      return {
        ...common(ctx),
        resource: objects,
        relationshipMode: { relationshipMode: relationshipOf(ctx, 0) },
        additionalColumns: extraColumns(ctx, kinds[0] ?? KIND_ALIASES['vm'] , ctx.s.list('columns')),
        mode: objects.length > 0 ? 'resource' : 'all',
        filterMode: filterModeOf(ctx),
        tagFilter: group ? groupFilter(ctx, group, ctx.s.get('grouptype', 'Environment')) : kindFilter(ctx, kinds),
        depth: ctx.s.num('depth', 1),
        customFilter: customFilterOf(ctx, kinds[0]),
        selectFirstRow: { selectFirstRow: ctx.s.yes('first', true) },
      };
    },
  },
  {
    type: 'View',
    label: 'View',
    family: 'list',
    verified: true,
    source: `${CF} _view_widget; ${NB} (cluster_capacity); ${REAL} (1,000 View widgets)`,
    doc: doc('view-widget'),
    note: 'The view is not in the dashboard export: import it first (Views › Manage › Import), or generate it with "A view for dashboards and reports" (same name, so the same id), or give a built-in view’s UUID.',
    provides: true,
    needsSubject: true,
    size: { w: 12, h: 6 },
    settings: [
      { key: 'view', type: 'text', required: true, help: 'the view’s name (generated by the view blueprint) or its UUID', label: 'Output Data (the view)', doc: doc('view-widget'), writes: ['viewDefinitionId'] },
      { key: 'first', type: 'yesno', help: 'select the first row on open, for a list view (default no)', label: 'Auto Select First Row', doc: doc('view-widget'), default: 'no', writes: ['selectFirstRow'] },
      { key: 'legend', type: 'choices', options: ['legend', 'labels', 'title'], help: 'for a chart view: what to show (chartViewItems)', label: 'Show', doc: doc('view-widget'), writes: ['chartViewItems'] },
      S.pin(),
      {
        key: 'traversal',
        type: 'text',
        options: ['vSphere Hosts and Clusters-VMWARE-vSphere World', 'vSphere Storage-VMWARE-vSphere World', 'Custom Groups-?-?'],
        help: 'the inventory tree the object is picked from (traversalSpecId; blank by default)',
        label: 'Input Data › Inventory trees',
        doc: doc('view-widget'),
        writes: ['traversalSpecId'],
        read: (src) => (typeof src.config['traversalSpecId'] === 'string' ? cellText(src.config['traversalSpecId']) : undefined),
      },
      { key: 'viewtype', type: 'choice', options: ['LIST', 'SUMMARY', 'TREND'], help: 'the view’s presentation, as some exports record it (viewType)', label: 'View type', writes: ['viewType'], read: readChoice('viewType', ['LIST', 'SUMMARY', 'TREND'], '') },
      S.refresh,
    ],
    passthrough: { custom: 'always [] in exports: an internal list the editor keeps', isUpdatedView: 'always true: marks a view widget saved by the 8.x+ editor' },
    build: (ctx) => {
      const pin = pinOf(ctx, undefined);
      const resId = ctx.selfProvider ? ctx.entries.resource(pin.ref, pin.name) : '';
      const traversal = ctx.s.get('traversal');
      return {
        refreshInterval: ctx.refreshInterval,
        resource: ctx.selfProvider ? { resourceId: resId, traversalSpecId: traversal, resourceName: pin.name, resourceKindId: kindId(pin.ref), id: `Ext.vcops.chrome.model.Resource-${Number(resId.replace(/\D/g, '')) + 1}` } : null,
        traversalSpecId: traversal || null,
        refreshContent: { refreshContent: ctx.refreshContent },
        isUpdatedView: true,
        chartViewItems: ctx.s.list('legend'),
        selectFirstRow: { selectFirstRow: ctx.s.yes('first', false) },
        selfProvider: { selfProvider: ctx.selfProvider },
        title: ctx.title,
        viewDefinitionId: ctx.viewId(ctx.s.get('view')),
        ...(ctx.s.has('viewtype') ? { viewType: ctx.s.get('viewtype') } : {}),
      };
    },
  },
  {
    type: 'Scoreboard',
    label: 'Scoreboard',
    family: 'chart',
    verified: true,
    source: `${CF} _scoreboard_widget; ${NB} (custom_vm_summary, roi), aakib011/vROPS-Dashboards, lhuckaba/vROpsESGDash; ${QA92} (gauge keys); ${REAL}`,
    doc: doc('scoreboard-widget'),
    provides: false,
    needsSubject: true,
    size: { w: 4, h: 4 },
    settings: [
      S.kind(),
      S.metrics(),
      S.labels,
      S.thresholds(),
      { key: 'unit', type: 'choice', options: Object.keys(METRIC_UNITS), help: 'the unit every box shows its value in (default Auto)', label: 'Unit', doc: doc('scoreboard-widget'), writes: ['metric'] },
      { key: 'max', type: 'number', help: 'full scale of a gauge (Max Value)', label: 'Max Value', doc: doc('scoreboard-widget'), writes: ['metric'] },
      { key: 'link', type: 'text', help: 'a page each box opens: an internal path or a web address', label: 'Link to', doc: doc('scoreboard-widget'), writes: ['metric'] },
      { key: 'theme', type: 'choice', options: SCOREBOARD_THEMES, help: 'tile style; gauge draws dials, the View Mode Gauge (default gradient)', label: 'Visual Theme / View Mode', doc: doc('scoreboard-widget'), default: 'gradient', writes: ['visualTheme'] },
      { key: 'columns', type: 'number', min: 1, max: 12, help: 'boxes per row (default 4)', label: 'Box Columns', doc: doc('scoreboard-widget'), default: '4', writes: ['boxColumns'] },
      { key: 'layout', type: 'choice', options: ['fixedView', 'fixedSize'], help: 'Fixed View fits the boxes to the widget; Fixed Size keeps their size (default fixedView)', label: 'Layout Mode', doc: doc('scoreboard-widget'), default: 'fixedView', writes: ['mode'] },
      { key: 'boxheight', type: 'number', min: 1, max: 1000, help: 'box height in pixels for Fixed Size (blank: automatic)', label: 'Fixed Size (box height)', doc: doc('scoreboard-widget'), writes: ['boxHeight'], read: readNum('boxHeight', null) },
      { key: 'valuesize', type: 'number', min: 6, max: 96, help: 'value font size in pixels (default 24)', label: 'Fixed View (value size)', doc: doc('scoreboard-widget'), default: '24', writes: ['valueSize'], read: readNum('valueSize', 24) },
      { key: 'labelsize', type: 'number', min: 6, max: 96, help: 'label font size in pixels (default 12)', label: 'Fixed View (label size)', doc: doc('scoreboard-widget'), default: '12', writes: ['labelSize'], read: readNum('labelSize', 12) },
      { key: 'decimals', type: 'number', min: 0, max: 5, help: 'decimal places (default 1)', label: 'Round Decimals', doc: doc('scoreboard-widget'), default: '1', writes: ['roundDecimals'] },
      { key: 'cells', type: 'number', min: 1, max: 1000, help: 'most boxes shown (default 100)', label: 'Max Scores Count', doc: doc('scoreboard-widget'), default: '100', writes: ['maxCellCount'] },
      { key: 'oldvalues', type: 'yesno', help: 'show the last value when there is no current one (default yes)', label: 'Old metric values', doc: doc('scoreboard-widget'), default: 'yes', writes: ['oldMetricValues'], read: readFlag('oldMetricValues', undefined, true) },
      { key: 'names', type: 'yesno', help: 'show object names (default no)', label: 'Show › Object Name', doc: doc('scoreboard-widget'), default: 'no', writes: ['showResourceName'] },
      { key: 'metricnames', type: 'yesno', help: 'show metric names (default yes)', label: 'Show › Metric Name', doc: doc('scoreboard-widget'), default: 'yes', writes: ['showMetricName'], read: readFlag('showMetricName', 'showMetricName', true) },
      { key: 'units', type: 'yesno', help: 'show metric units (default yes)', label: 'Show › Metric Unit', doc: doc('scoreboard-widget'), default: 'yes', writes: ['showMetricUnit'], read: readFlag('showMetricUnit', 'showMetricUnit', true) },
      { key: 'sparkline', type: 'yesno', help: 'a sparkline under each value (default no)', label: 'Show › Sparkline', doc: doc('scoreboard-widget'), default: 'no', writes: ['showSparkline'] },
      S.period('the time span of the sparkline statistics'),
      { key: 'showdt', type: 'yesno', help: 'show the dynamic threshold on the sparkline (default yes)', label: 'Show DT', doc: doc('scoreboard-widget'), default: 'yes', writes: ['showDT'], read: readFlag('showDT', 'showDT', true) },
      { key: 'remaining', type: 'yesno', help: 'gauge: show what remains to the maximum (default no)', label: 'Gauge (show remaining)', writes: ['showRemaining'], read: readFlag('showRemaining', undefined, false) },
      { key: 'percenttext', type: 'yesno', help: 'gauge: show the value as a percentage (default no)', label: 'Gauge (percent text)', writes: ['showPercentText'], read: readFlag('showPercentText', undefined, false) },
      { key: 'focuspercent', type: 'yesno', help: 'gauge: make the percentage the main figure (default no)', label: 'Gauge (focus on percent)', writes: ['focusOnPercent'], read: readFlag('focusOnPercent', undefined, false) },
      S.objects('scoreboard-widget', ['resource']),
      S.relationship('self', 'scoreboard-widget'),
      { ...S.depth(), read: readNum('depth', 1) },
      S.filter('scoreboard-widget', ['customFilter']),
      S.filterkind('scoreboard-widget'),
      S.metricconfig('scoreboard-widget'),
      S.refresh,
    ],
    passthrough: { undefined: UNDEFINED_KEY },
    alsoWrites: { showRemaining: QA92, showPercentText: QA92, focusOnPercent: QA92 },
    build: (ctx) => {
      const kind = ctx.s.kind('kind', KIND_ALIASES['vm']) ;
      const theme = SCOREBOARD_THEMES.indexOf(ctx.s.get('theme', 'gradient')                                      ) + 1 || 8;
      return {
        ...common(ctx),
        metric: metricBlock(ctx, kind, ctx.s.list('metrics')),
        resource: objectsOf(ctx),
        relationshipMode: { relationshipMode: relationshipOf(ctx, 0) },
        customFilter: customFilterOf(ctx, kind),
        depth: ctx.s.num('depth', 1),
        resInteractionMode: ctx.s.get('metricconfig') || null,
        visualTheme: theme,
        mode: { layoutMode: ctx.s.get('layout', 'fixedView') },
        showResourceName: { showResourceName: ctx.s.yes('names', false) },
        showMetricName: { showMetricName: ctx.s.yes('metricnames', true) },
        showMetricUnit: { showMetricUnit: ctx.s.yes('units', true) },
        showDT: { showDT: ctx.s.yes('showdt', true) },
        showSparkline: { showSparkline: ctx.s.yes('sparkline', false) },
        periodLength: ctx.s.has('period') ? ctx.s.get('period') : null,
        maxCellCount: ctx.s.num('cells', 100),
        oldMetricValues: ctx.s.yes('oldvalues', true),
        roundDecimals: ctx.s.num('decimals', 1),
        valueSize: ctx.s.num('valuesize', 24),
        labelSize: ctx.s.num('labelsize', 12),
        boxHeight: ctx.s.has('boxheight') ? ctx.s.num('boxheight', 0) : null,
        boxColumns: ctx.s.num('columns', 4),
        ...(theme === 9 || ctx.s.has('remaining') || ctx.s.has('percenttext') || ctx.s.has('focuspercent')
          ? { showRemaining: ctx.s.yes('remaining', false), showPercentText: ctx.s.yes('percenttext', false), focusOnPercent: ctx.s.yes('focuspercent', false) }
          : {}),
      };
    },
  },
  {
    type: 'ScoreboardHealth',
    label: 'Scoreboard Health',
    family: 'badge',
    verified: true,
    source: `${SURVEY}; ${REAL}`,
    doc: doc('scoreboard-health-widget'),
    provides: false,
    needsSubject: true,
    size: { w: 3, h: 4 },
    settings: [
      { key: 'badge', type: 'choice', options: ['health', 'risk', 'efficiency', 'custom'], help: 'which score, or custom for a metric of your own (default health)', label: 'Metric', doc: doc('scoreboard-health-widget'), default: 'health', writes: ['metricType'] },
      { key: 'metric', type: 'metric', help: 'the custom metric, when Metric is custom', label: 'Pick Metric', doc: doc('scoreboard-health-widget'), writes: ['metricValue'], read: readText('metricValue') },
      { key: 'image', type: 'choice', options: ['circle', 'square'], help: 'icon shape (default circle; square is not seen in an export)', label: 'Image Type', doc: doc('scoreboard-health-widget'), default: 'circle', writes: ['imageType'] },
      S.refresh,
    ],
    passthrough: { resources: 'the Input Data objects; only [] has been seen, so the item shape is not known' },
    build: (ctx) => ({ ...common(ctx), metricType: { metricType: ctx.s.get('badge', 'health') }, metricValue: ctx.s.get('metric'), resources: [], imageType: ctx.s.get('image', 'circle') }),
  },
  {
    type: 'Heatmap',
    label: 'Heat Map',
    family: 'chart',
    verified: true,
    source: `${CF} _heatmap_widget; ${BP} (Cluster CPU Details: sizeBy num_Cpu, colorBy cpu|usage_average, groupBy HostSystem); ${REAL}`,
    doc: doc('heat-map-widget'),
    note: 'The builder writes one configuration (the first); any more a loaded heat map holds are kept as exported.',
    provides: true,
    needsSubject: false,
    size: { w: 6, h: 6 },
    settings: [
      { ...S.kind(true, 'the objects drawn as tiles'), label: 'Object Type', doc: doc('heat-map-widget'), writes: ['configs'] },
      { key: 'colorby', type: 'metric', required: true, help: 'the metric that colours a tile', label: 'Color by', doc: doc('heat-map-widget'), writes: ['configs'] },
      { key: 'sizeby', type: 'metric', help: 'the metric that sizes a tile (default: all the same size)', label: 'Size by', doc: doc('heat-map-widget'), writes: ['configs'] },
      { key: 'groupby', type: 'kind', help: 'group tiles under this object type (default: the tile type itself)', label: 'Group by', doc: doc('heat-map-widget'), writes: ['configs'] },
      { key: 'thenby', type: 'kind', help: 'a second level of grouping under Group by', label: 'Then by', doc: doc('heat-map-widget'), writes: ['configs'] },
      { key: 'relational', type: 'yesno', help: 'relate the Group by and Then by objects to each other (default no)', label: 'Relational Grouping', doc: doc('heat-map-widget'), default: 'no', writes: ['configs'] },
      { key: 'heatmode', type: 'choice', options: ['general', 'instance'], help: 'General sizes by one metric and colours by another; Instance draws one equal tile per metric instance (default general)', label: 'Mode', doc: doc('heat-map-widget'), default: 'general', writes: ['configs'] },
      { key: 'focus', type: 'yesno', help: 'zoom to the group of the object selected (focusOnGroups; default yes)', label: 'Group Zoom', doc: doc('heat-map-widget'), default: 'yes', writes: ['configs'] },
      { key: 'configname', type: 'text', help: 'the configuration’s name (default: the widget title)', label: 'Name', doc: doc('heat-map-widget'), writes: ['configs'] },
      { key: 'values', type: 'numbers', help: 'colour stops, ascending: 0,50,100', label: 'Color (thresholds)', doc: doc('heat-map-widget'), writes: ['configs'] },
      { key: 'colors', type: 'colors', help: 'one colour per stop, #rrggbb: #8ABF5B,#EACC58,#E4695E', label: 'Color', doc: doc('heat-map-widget'), writes: ['configs'] },
      { key: 'min', type: 'number', help: 'lowest value on the colour scale (default 0)', label: 'Min Value', doc: doc('heat-map-widget'), default: '0', writes: ['configs'] },
      { key: 'max', type: 'number', help: 'highest value on the colour scale (default 100)', label: 'Max Value', doc: doc('heat-map-widget'), default: '100', writes: ['configs'] },
      { key: 'solid', type: 'yesno', help: 'solid colours rather than a gradient (default no)', label: 'Solid Coloring', doc: doc('heat-map-widget'), default: 'no', writes: ['configs'] },
      S.objects('heat-map-widget'),
      { ...S.relationship('self,children,parents', 'heat-map-widget', true), read: (src) => { const t = relationshipText(at(src.config, 'relationshipMode', 'relationshipMode')); return t && t !== 'parents,children,self' ? t : undefined; } },
      { ...S.depth(10, 10), writes: ['depth'] },
      S.filter('heat-map-widget', ['configs']),
      S.filterkind('heat-map-widget', ['configs']),
      S.refresh,
    ],
    passthrough: { value: 'the index of the configuration the widget opens on; the builder writes one configuration, index 0' },
    build: (ctx) => {
      const kind = ctx.s.kind('kind', KIND_ALIASES['vm']) ;
      const group = ctx.s.kind('groupby') ?? kind;
      const then = ctx.s.kind('thenby');
      const values = ctx.s.nums('values');
      const colors = ctx.s.list('colors');
      const sizeBy = ctx.s.get('sizeby');
      const grouping = (ref         )         => ({
        resourceKind: ref.resourceKind,
        adapterKind: ref.adapterKind,
        typeId: ctx.entries.kind(ref),
        type: 'resourceKind',
        text: ref.resourceKind,
        originalText: ref.resourceKind,
        id: `004null${kindId(ref)}`,
        parentText: ref.adapterKind,
        parentId: ref.adapterKind,
      });
      const objects = objectsOf(ctx);
      return {
        mode: objects.length > 0 ? 'resource' : 'all',
        depth: ctx.s.num('depth', 10),
        selfProvider: { selfProvider: ctx.selfProvider },
        refreshInterval: ctx.refreshInterval,
        refreshContent: { refreshContent: ctx.refreshContent },
        resource: objects,
        relationshipMode: { relationshipMode: relationshipOf(ctx, [1, -1, 0]) },
        title: ctx.title,
        configs: [
          {
            name: ctx.s.get('configname', ctx.title),
            resourceKind: ctx.entries.kind(kind),
            colorBy: { metricKey: ctx.s.get('colorby'), value: ctx.s.get('colorby') },
            sizeBy: { metricKey: sizeBy || null, value: sizeBy },
            groupBy: grouping(group),
            thenBy: then ? grouping(then) : null,
            color: {
              minValue: ctx.s.num('min', 0),
              maxValue: ctx.s.num('max', 100),
              thresholds: { values: values.length > 0 ? values : [0, 50, 100], colors: colors.length > 0 ? colors : ['#8ABF5B', '#EACC58', '#E4695E'] },
            },
            focusOnGroups: ctx.s.yes('focus', true),
            relationalGrouping: ctx.s.yes('relational', false),
            solidColoring: ctx.s.yes('solid', false),
            mode: { mode: ctx.s.get('heatmode', 'general') === 'instance' },
            attributeKind: { value: '' },
            filterMode: filterModeOf(ctx),
            tagFilter: null,
            customFilter: customFilterOf(ctx, kind),
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
    source: `${CF} _health_chart_widget; ${QA92} (vendor-template-Home); ${BP} (ESX Host Details v2); ${REAL}`,
    doc: doc('health-chart-widget'),
    note: 'metric=badge|health, badge|risk or badge|efficiency charts the score (metricType health/risk/efficiency); any other key is a custom metric.',
    provides: true,
    needsSubject: true,
    size: { w: 6, h: 4 },
    settings: [
      { ...S.kind(), writes: ['resourceKindId'] },
      { ...S.metric(true, 'the metric charted: cpu|usage_average, or badge|health'), doc: doc('health-chart-widget'), writes: ['metricKey', 'metricType'] },
      { key: 'metricname', type: 'text', help: 'the metric’s display name, Group|Name (default: the key)', label: 'Metric (name)', doc: doc('health-chart-widget'), writes: ['metricName', 'metricFullName'], read: (src) => { const n = src.config['metricName']; return typeof n === 'string' && n !== src.config['metricKey'] ? cellText(n) : undefined; } },
      S.unit('metricUnit', 'Default Unit'),
      S.thresholds(['yellowBound', 'orangeBound', 'redBound']),
      { key: 'sortby', type: 'choice', options: ['metricValue', 'name'], help: 'sort the charts by value or by object name (default metricValue)', label: 'Order By', doc: doc('health-chart-widget'), default: 'metricValue', writes: ['sortBy'], read: readChoice('sortBy', ['metricValue', 'name'], 'metricValue') },
      { key: 'order', type: 'choice', options: ['asc', 'desc'], help: 'ascending or descending (default asc)', label: 'Order By (direction)', doc: doc('health-chart-widget'), default: 'asc', writes: ['sortByDir'] },
      { key: 'rows', type: 'number', min: 1, max: 100, help: 'charts per page (default 15)', label: 'Pagination number', doc: doc('health-chart-widget'), default: '15', writes: ['paginationNumber'] },
      { key: 'height', type: 'number', min: 60, max: 400, help: 'chart height in pixels: 115, 135 (the default) and 190 are the Small, Medium and Large exports hold', label: 'Chart Height', doc: doc('health-chart-widget'), default: '135', writes: ['chartHeight'] },
      { key: 'names', type: 'yesno', help: 'show the object name (default yes)', label: 'Show › Object Name', doc: doc('health-chart-widget'), default: 'yes', writes: ['showResourceName'], read: readFlag('showResourceName', 'showResourceName', true) },
      { key: 'metriclabel', type: 'text', help: 'show the metric name, with this label', label: 'Show › Metric Name', doc: doc('health-chart-widget'), writes: ['showMetricLabel', 'metricLabel'], read: readText('metricLabel') },
      { key: 'first', type: 'yesno', help: 'select the first chart on open (default no)', label: 'Auto Select First Row', doc: doc('health-chart-widget'), default: 'no', writes: ['selectFirstRow'], read: readFlag('selectFirstRow', 'selectFirstRow', false) },
      { key: 'mode', type: 'choice', options: ['all', 'self', 'resource'], help: 'all the objects below the one sent (default), just that one, or a pinned one', label: 'Input Data', doc: doc('health-chart-widget'), default: 'all', writes: ['mode'] },
      S.pin(),
      S.kinds(false),
      S.relationship('self', 'health-chart-widget'),
      S.period(),
      S.depth(),
      S.filter('health-chart-widget'),
      S.filterkind('health-chart-widget'),
      S.refresh,
    ],
    passthrough: { undefined: UNDEFINED_KEY },
    build: (ctx) => {
      const kind = ctx.s.kind('kind', KIND_ALIASES['vm']) ;
      const metric = ctx.s.get('metric');
      const badge = /^badge\|(health|risk|efficiency)$/.exec(metric)?.[1];
      const bounds = ctx.s.nums('thresholds');
      const pin = pinOf(ctx, kind);
      const kinds = ctx.s.kinds('kinds');
      const name = ctx.s.get('metricname', metric);
      return {
        ...common(ctx),
        resource: ctx.selfProvider ? [{ name: pin.name, id: ctx.entries.resource(pin.ref, pin.name) }] : [],
        relationshipMode: { relationshipMode: relationshipOf(ctx, 0) },
        mode: ctx.s.get('mode', 'all'),
        filterMode: filterModeOf(ctx),
        tagFilter: kinds.length > 0 ? kindFilter(ctx, kinds) : null,
        depth: ctx.s.num('depth', 1),
        customFilter: customFilterOf(ctx, kind),
        metricKey: metric,
        metricName: name,
        metricFullName: name,
        resourceKindId: ctx.entries.kind(kind),
        metricUnit: unitOf(ctx, 'Default Unit'),
        metricType: { metricType: badge ?? 'custom' },
        chartHeight: ctx.s.num('height', 135),
        yellowBound: bounds.length === 3 ? bounds[0] : null,
        orangeBound: bounds.length === 3 ? bounds[1] : null,
        redBound: bounds.length === 3 ? bounds[2] : null,
        sortBy: ctx.s.get('sortby', 'metricValue'),
        sortByDir: { orderByDir: ctx.s.get('order', 'asc') },
        paginationNumber: ctx.s.num('rows', 15),
        showResourceName: { showResourceName: ctx.s.yes('names', true) },
        showMetricLabel: { showMetricLabel: ctx.s.has('metriclabel') },
        metricLabel: ctx.s.get('metriclabel'),
        selectFirstRow: { selectFirstRow: ctx.s.yes('first', false) },
        ...(ctx.s.has('period') ? { periodLength: ctx.s.get('period') } : {}),
      };
    },
  },
  {
    type: 'MetricChart',
    label: 'Metric Chart',
    family: 'chart',
    verified: true,
    source: `${CF} _metric_chart_widget; ${BP} (ESX Host Performance Details v2); ${NB} (cluster_capacity); ${REAL}`,
    doc: doc('metric-chart-widget'),
    note: 'Line, area or bar, split and stacked charts are per-user preferences kept in the widget’s states, not in config; it opens as a line chart.',
    provides: false,
    needsSubject: true,
    size: { w: 6, h: 5 },
    settings: [
      S.kind(),
      S.metrics(),
      S.labels,
      { key: 'unit', type: 'choice', options: Object.keys(METRIC_UNITS), help: 'the unit the metrics are charted in (default: each metric’s own)', label: 'Unit', doc: doc('metric-chart-widget'), writes: ['metric'] },
      { key: 'objectmetrics', type: 'text', help: 'metrics of objects picked by name: alias:Object name=metric|key, comma separated (Input Data › Metrics)', label: 'Input Data › Metrics', doc: doc('metric-chart-widget'), writes: ['resourceMetrics'] },
      S.objects('metric-chart-widget', ['resource']),
      S.relationship('self', 'metric-chart-widget'),
      { ...S.depth(), read: readNum('depth', 1) },
      S.filter('metric-chart-widget', ['customFilter']),
      S.filterkind('metric-chart-widget'),
      S.metricconfig('metric-chart-widget'),
      S.refresh,
    ],
    build: (ctx) => {
      const kind = ctx.s.kind('kind', KIND_ALIASES['vm']) ;
      return {
        ...common(ctx),
        metric: metricBlock(ctx, kind, ctx.s.list('metrics')),
        resourceMetrics: objectMetricsOf(ctx),
        resource: objectsOf(ctx),
        relationshipMode: { relationshipMode: relationshipOf(ctx, 0) },
        customFilter: customFilterOf(ctx, kind),
        depth: ctx.s.num('depth', 1),
        resInteractionMode: ctx.s.get('metricconfig') || null,
      };
    },
  },
  {
    type: 'SparklineChart',
    label: 'Sparkline Chart',
    family: 'chart',
    verified: true,
    source: `${SURVEY} §SparklineChart; ${BP} (VM Details v4); ${REAL}`,
    doc: doc('sparkline-chart-widget'),
    provides: false,
    needsSubject: true,
    size: { w: 4, h: 5 },
    settings: [
      S.kind(),
      S.metrics(),
      S.labels,
      { key: 'order', type: 'choice', options: ['graphFirst', 'labelFirst'], help: 'graph or label first (default graphFirst)', label: 'Column Sequence', doc: doc('sparkline-chart-widget'), default: 'graphFirst', writes: ['columnSequence'] },
      { key: 'names', type: 'yesno', help: 'show the object name (default no)', label: 'Show Object Name', doc: doc('sparkline-chart-widget'), default: 'no', writes: ['showResourceName'] },
      { key: 'showdt', type: 'yesno', help: 'show the dynamic threshold (default yes)', label: 'Show DT', doc: doc('sparkline-chart-widget'), default: 'yes', writes: ['showDT'], read: readFlag('showDT', 'showDT', true) },
      S.objects('sparkline-chart-widget', ['resource']),
      S.relationship('self', 'sparkline-chart-widget'),
      { ...S.depth(), read: readNum('depth', 1) },
      S.filter('sparkline-chart-widget', ['customFilter']),
      S.filterkind('sparkline-chart-widget'),
      S.metricconfig('sparkline-chart-widget'),
      S.refresh,
    ],
    build: (ctx) => {
      const kind = ctx.s.kind('kind', KIND_ALIASES['vm']) ;
      return {
        ...common(ctx),
        resource: objectsOf(ctx),
        showDT: { showDT: ctx.s.yes('showdt', true) },
        relationshipMode: { relationshipMode: relationshipOf(ctx, 0) },
        showResourceName: { showObjectName: ctx.s.yes('names', false) },
        depth: ctx.s.num('depth', 1),
        columnSequence: { columnSequence: ctx.s.get('order', 'graphFirst') },
        metric: metricBlock(ctx, kind, ctx.s.list('metrics')),
        customFilter: customFilterOf(ctx, kind),
        resInteractionMode: ctx.s.get('metricconfig') || null,
      };
    },
  },
  {
    type: 'ParetoAnalysis',
    label: 'Top-N',
    family: 'chart',
    verified: true,
    source: `${CF} _pareto_analysis_widget (mode all); ${NB} (reclaimable_hosts, storage_tier_cost_analysis), lhuckaba/vROpsESGDash; ${REAL}`,
    doc: doc('top-n-widget'),
    provides: true,
    needsSubject: false,
    size: { w: 4, h: 6 },
    settings: [
      { ...S.kind(), writes: ['resourceKind'] },
      { ...S.metric(), label: 'Output Data › Metric', doc: doc('top-n-widget'), writes: ['metric'] },
      { key: 'top', type: 'number', min: 1, max: 100, help: 'how many bars (default 10)', label: 'Bars Count', doc: doc('top-n-widget'), default: '10', writes: ['barsCount'] },
      { key: 'order', type: 'choice', options: Object.keys(TOPN_ORDERS), help: 'the analysis: highest or lowest utilization (Metric Analysis), least or most healthy, most alarming (default highest)', label: 'Metric Analysis / Application Health', doc: doc('top-n-widget'), default: 'highest', writes: ['topOption'] },
      { key: 'label', type: 'text', help: 'what the metric is called on the chart', label: 'Output Data › Label', doc: doc('top-n-widget'), writes: ['metricName', 'metric'] },
      S.unit('metricUnit', 'Auto'),
      { key: 'max', type: 'number', help: 'the value a full bar stands for (default: automatic)', label: 'Output Data › Maximum', doc: doc('top-n-widget'), writes: ['maxValue'], read: readNum('maxValue', null), unverified: true },
      S.thresholds(['yellowBound', 'orangeBound', 'redBound']),
      { key: 'percentile', type: 'number', min: 1, max: 100, help: 'the percentile for Metric Analysis › Percentile', label: 'Percentile', doc: doc('top-n-widget'), writes: ['percentileValue'], read: readNum('percentileValue', null) },
      {
        key: 'period',
        type: 'choice',
        options: Object.keys(TOPN_PERIODS),
        help: 'the time the values are taken over (default: the widget’s date range)',
        label: 'Select Date Range',
        doc: doc('top-n-widget'),
        writes: ['periodLength'],
        read: (src) => { const r = at(src.config, 'periodLength', 'dateRange'); return typeof r === 'string' && TOPN_PERIODS[r] && at(src.config, 'periodLength', 'dateRangeText') === TOPN_PERIODS[r] ? r : undefined; },
      },
      { key: 'columns', type: 'metrics', help: 'extra metric columns, comma separated', label: 'Additional Columns', doc: doc('top-n-widget'), writes: ['additionalColumns'] },
      { key: 'columnlabels', type: 'text', help: 'labels for the extra columns, comma separated (default: the metric key)', label: 'Additional Columns (label)', doc: doc('top-n-widget'), writes: ['additionalColumns'] },
      { key: 'decimals', type: 'number', min: 0, max: 5, help: 'decimal places (default 1)', label: 'Round Decimals', doc: doc('top-n-widget'), default: '1', writes: ['roundDecimals'] },
      { key: 'every', type: 'number', min: 1, max: 1440, help: 'minutes between recalculations (default 15)', label: 'Redraw Rate', doc: doc('top-n-widget'), default: '15', writes: ['regenerationTime'] },
      { key: 'oldmetrics', type: 'yesno', help: 'leave out objects whose metric has stopped collecting (default no)', label: 'Filter old metrics', doc: doc('top-n-widget'), default: 'no', writes: ['filterOldMetrics'], read: readFlag('filterOldMetrics', 'filterOldMetrics', false) },
      S.objects('top-n-widget'),
      ...S.group,
      { ...S.relationship('children,self', 'top-n-widget', true), read: (src) => { const t = relationshipText(at(src.config, 'relationshipMode', 'relationshipMode')); return t && t !== 'children,self' ? t : undefined; } },
      S.depth(10, 10),
      S.filter('top-n-widget'),
      S.filterkind('top-n-widget'),
      S.refresh,
    ],
    passthrough: {
      metricOption: 'the 8.x "metric" mode’s metric tree selection; the 9.x Top-N writes metric and topOption instead',
      tagOption: 'the 8.x "tagFilter" mode’s health analysis; the 9.x Top-N writes topOption instead',
      additionalColumns_resource: 'always [] in exports: additional columns for picked objects',
    },
    build: (ctx) => {
      const kind = ctx.s.kind('kind', KIND_ALIASES['vm']) ;
      const metric = ctx.s.get('metric');
      const bounds = ctx.s.nums('thresholds');
      const objects = objectsOf(ctx);
      const group = ctx.s.get('group');
      const period = ctx.s.get('period');
      return {
        ...common(ctx),
        resource: objects,
        relationshipMode: { relationshipMode: relationshipOf(ctx, [-1, 0]) },
        mode: objects.length > 0 ? 'resource' : 'all',
        filterMode: filterModeOf(ctx),
        tagFilter: group ? groupFilter(ctx, group, ctx.s.get('grouptype', 'Environment')) : null,
        depth: ctx.s.num('depth', 10),
        customFilter: customFilterOf(ctx, kind),
        filterOldMetrics: { filterOldMetrics: ctx.s.yes('oldmetrics', false) },
        topOption: TOPN_ORDERS[ctx.s.get('order', 'highest')] ?? TOPN_ORDERS['highest'],
        barsCount: ctx.s.num('top', 10),
        roundDecimals: ctx.s.num('decimals', 1),
        regenerationTime: ctx.s.num('every', 15),
        percentileValue: ctx.s.has('percentile') ? ctx.s.num('percentile', 90) : null,
        metricName: ctx.s.get('label', metric),
        metricUnit: unitOf(ctx, 'Auto'),
        additionalColumns: extraColumns(ctx, kind, ctx.s.list('columns')),
        metric: { metricKey: metric, name: ctx.s.get('label', metric) },
        resourceKind: [{ id: ctx.entries.kind(kind) }],
        ...(bounds.length === 3 ? { yellowBound: bounds[0], orangeBound: bounds[1], redBound: bounds[2] } : {}),
        ...(ctx.s.has('max') ? { maxValue: ctx.s.num('max', 100) } : {}),
        ...(TOPN_PERIODS[period] ? { periodLength: { dateRange: period, dateRangeText: TOPN_PERIODS[period] } } : {}),
      };
    },
  },
  {
    type: 'RollingViewChart',
    label: 'Rolling View Chart',
    family: 'chart',
    verified: true,
    source: `vmspot/vROps-Dashboards (TAM Contention Trends), craigeherring/vROPsDashboards (8.x exports); ${REAL}`,
    doc: doc('rolling-view-chart-widget'),
    provides: false,
    needsSubject: true,
    size: { w: 6, h: 5 },
    settings: [
      S.kind(),
      S.metrics(),
      S.labels,
      { key: 'unit', type: 'choice', options: Object.keys(METRIC_UNITS), help: 'the unit the metrics are charted in (default: each metric’s own)', label: 'Unit', doc: doc('rolling-view-chart-widget'), writes: ['metric'] },
      { key: 'interval', type: 'number', min: 5, max: 3600, help: 'seconds each metric is shown (default 30)', label: 'Auto Transition Interval', doc: doc('rolling-view-chart-widget'), default: '30', writes: ['autoTransitionInterval'] },
      { key: 'toolbar', type: 'yesno', help: 'show the chart toolbar (default yes; written only when set, as the 8.x exports have it)', label: 'Toolbar', default: 'yes', writes: ['showChartToolbar'] },
      S.objects('rolling-view-chart-widget', ['resource']),
      S.relationship('self', 'rolling-view-chart-widget'),
      { ...S.depth(), read: readNum('depth', 1) },
      S.filter('rolling-view-chart-widget', ['customFilter']),
      S.filterkind('rolling-view-chart-widget'),
      S.metricconfig('rolling-view-chart-widget'),
      S.refresh,
    ],
    alsoWrites: { showChartToolbar: 'craigeherring/vROPsDashboards (8.x export), only when toolbar= is set' },
    build: (ctx) => {
      const kind = ctx.s.kind('kind', KIND_ALIASES['vm']) ;
      return {
        ...common(ctx),
        autoTransitionInterval: ctx.s.num('interval', 30),
        metric: metricBlock(ctx, kind, ctx.s.list('metrics')),
        relationshipMode: { relationshipMode: relationshipOf(ctx, 0) },
        resInteractionMode: ctx.s.get('metricconfig') || null,
        resource: objectsOf(ctx),
        customFilter: customFilterOf(ctx, kind),
        depth: ctx.s.num('depth', 1),
        ...(ctx.s.has('toolbar') ? { showChartToolbar: { showChartToolbar: ctx.s.yes('toolbar', true) } } : {}),
      };
    },
  },
  {
    type: 'MashupChart',
    label: 'Mashup Chart',
    family: 'chart',
    verified: true,
    source: `${SURVEY} §MashupChart (config is the four common keys; what it charts is kept in the widget’s states); ${REAL}`,
    doc: doc('mashup-chart-widget'),
    note: 'Its filters (criticality, status, alert type, events) and date range are per-user states the toolbar keeps, not config.',
    provides: false,
    needsSubject: true,
    size: { w: 6, h: 6 },
    settings: BLANK_ONLY,
    passthrough: { resourceName: 'only "" seen: the object an 8.x mashup chart was opened on' },
    build: (ctx) => common(ctx),
  },
  {
    type: 'PropertyList',
    label: 'Property List',
    family: 'list',
    verified: true,
    source: `${CF} _property_list_widget (showMetricFullName’s inner key is metricFullName); ${NB} (cluster_capacity, rightsizing_details); ${REAL}`,
    doc: doc('property-list-widget'),
    provides: false,
    needsSubject: true,
    size: { w: 4, h: 5 },
    settings: [
      S.kind(),
      S.metrics(false),
      { key: 'props', type: 'metrics', help: 'text properties, comma separated: config|name,summary|parentHost', label: 'Output Data (properties)', doc: doc('property-list-widget'), writes: ['metric'] },
      S.labels,
      S.thresholds(),
      { key: 'unit', type: 'choice', options: Object.keys(METRIC_UNITS), help: 'the unit the metric values are shown in (default: each metric’s own)', label: 'Unit', doc: doc('property-list-widget'), writes: ['metric'] },
      { key: 'theme', type: 'number', min: 0, max: 5, help: 'style: the docs list Original and Compact; exports hold 0 (the default) and 2', label: 'Visual Theme', doc: doc('property-list-widget'), default: '0', writes: ['visualTheme'] },
      { key: 'fullnames', type: 'yesno', help: 'show full metric names (default yes)', label: 'Show Metric Full Name', doc: doc('property-list-widget'), default: 'yes', writes: ['showMetricFullName'] },
      S.objects('property-list-widget', ['resource']),
      S.relationship('self', 'property-list-widget'),
      { ...S.depth(), read: readNum('depth', 1) },
      S.filter('property-list-widget', ['customFilter']),
      S.filterkind('property-list-widget'),
      S.metricconfig('property-list-widget'),
      S.refresh,
    ],
    build: (ctx) => {
      const kind = ctx.s.kind('kind', KIND_ALIASES['vm']) ;
      return {
        ...common(ctx),
        visualTheme: ctx.s.num('theme', 0),
        depth: ctx.s.num('depth', 1),
        metric: metricBlock(ctx, kind, ctx.s.list('metrics'), ctx.s.list('props')),
        resource: objectsOf(ctx),
        relationshipMode: { relationshipMode: relationshipOf(ctx, 0) },
        customFilter: customFilterOf(ctx, kind),
        showMetricFullName: { metricFullName: ctx.s.yes('fullnames', true) },
        resInteractionMode: ctx.s.get('metricconfig') || null,
      };
    },
  },
  {
    type: 'TextDisplay',
    label: 'Text Display',
    family: 'text',
    verified: true,
    source: `${CF} _text_display_widget; ${NB} (cluster_capacity), lhuckaba/vROpsESGDash (HTML in editorData); ${REAL}`,
    doc: doc('text-display-widget'),
    note: 'text= is shown as written (escaped); html= is custom HTML, as the editor’s HTML mode keeps it; url= loads a page (a ContentPack/… path or a web address); file= a file from Text Widget Content. text= and html= take the rest of the cell.',
    provides: false,
    needsSubject: false,
    size: { w: 12, h: 2 },
    settings: [
      { key: 'url', type: 'text', help: 'a page to show instead of text', label: 'URL', doc: doc('text-display-widget'), writes: ['locationUrl', 'editorData'] },
      { key: 'file', type: 'text', help: 'a file managed under Configurations › Text Widget Content, shown instead of text', label: 'File', doc: doc('text-display-widget'), writes: ['locationFile', 'editorData'], read: readText('locationFile') },
      { key: 'viewmode', type: 'choice', options: ['html', 'text'], help: 'rich text (HTML) or plain text (default html; HTML only when URL and File are blank)', label: 'View mode', doc: doc('text-display-widget'), default: 'html', writes: ['viewModeHTML'], read: (src) => (src.config['viewModeHTML'] === false ? 'text' : undefined) },
      { key: 'text', type: 'rest', help: 'plain text (the rest of the cell)', label: 'Text', doc: doc('text-display-widget'), writes: ['editorData'] },
      { key: 'html', type: 'rest', help: 'custom HTML (the rest of the cell)', label: 'Text (HTML)', doc: doc('text-display-widget'), writes: ['editorData'] },
      S.refresh,
    ],
    passthrough: { xtype: 'the class of a getting-started panel some shipped dashboards use (widget.gettingStarted), not a Text Display option' },
    build: (ctx) => {
      const html = ctx.s.has('html') ? ctx.s.get('html') : `<div style="font-size: 14px;">${escapeHtml(ctx.s.get('text'))}</div>`;
      return {
        editorData: ctx.s.has('url') || ctx.s.has('file') ? '' : html,
        locationFile: ctx.s.get('file'),
        locationUrl: ctx.s.get('url'),
        refreshInterval: ctx.refreshInterval,
        refreshContent: { refreshContent: false },
        title: ctx.title,
        titleLocalized: ctx.title,
        viewModeHTML: ctx.s.get('viewmode', 'html') !== 'text',
      };
    },
  },
  {
    type: 'Section',
    label: 'Section',
    family: 'text',
    verified: true,
    source: `${QA92} (qa-9.2.0 export, vendor ComputeOps template); ${CF} _section_widget; ${BP} (vCenter and ESX Host Versions)`,
    doc: 'https://techdocs.broadcom.com/us/en/vmware-cis/vcf/vcf-9-0-and-later/9-1/infrastructure-operations/dashboards-and-widgets/using-dashboards/create-and-configure-dashboards/widget-or-view-list-details.html',
    note: 'Add Section in the dashboard editor. A full-width collapsible heading: 12 wide and 1 high whatever the row says, holding the widgets below it down to the next Section (its config lists their ids). Widgets above the first section belong to none.',
    provides: false,
    needsSubject: false,
    size: { w: 12, h: 1 },
    settings: [
      { key: 'collapsed', type: 'yesno', help: 'start collapsed (default no)', label: 'Collapse', default: 'no' },
      { key: 'description', type: 'text', help: 'a line under the heading', label: 'Description', writes: ['description'] },
    ],
    passthrough: { widgets: 'the ids of the widgets below it, down to the next section: worked out from the layout', widgetId: 'the section’s own id, as 9.2 writes it' },
    build: (ctx) => ({ title: ctx.title, titleLocalized: ctx.title, description: ctx.s.get('description'), widgets: [] }),
  },
  {
    type: 'AlertList',
    label: 'Alert List',
    family: 'alert',
    verified: true,
    source: `${CF} _alert_list_widget; ${QA92} (License Server Alerts); ${BP} (Alert and Troubleshoot, Cluster Capacity Details v7); ${REAL}`,
    doc: doc('alert-list-widget'),
    note: 'Type codes are <type>_<subtype> for types 15 to 20, as the exports have them (…_19 performance, …_20 capacity); availability, compliance and configuration use the subtype numbers the alert definitions API lists (18, 21, 22).',
    provides: true,
    needsSubject: false,
    size: { w: 12, h: 5 },
    settings: [
      S.kinds(false),
      ...S.group,
      S.objects('alert-list-widget'),
      { key: 'criticality', type: 'choices', options: Object.keys(CRITICALITY), help: 'which criticalities (default warning,immediate,critical)', label: 'Criticality', doc: doc('alert-list-widget'), default: 'warning,immediate,critical', writes: ['criticalityLevel'] },
      { key: 'status', type: 'choice', options: ['active', 'all'], help: 'active alerts only (default) or all', label: 'Status', doc: doc('alert-list-widget'), default: 'active', writes: ['status'] },
      { key: 'controlstate', type: 'choices', options: ['open'], help: 'control states to include (default all); open (0) is the only one an export holds', label: 'Control State', doc: doc('alert-list-widget'), writes: ['state'], read: (src) => (Array.isArray(src.config['state']) && src.config['state'].length === 1 && src.config['state'][0] === 0 ? 'open' : undefined) },
      { key: 'types', type: 'choices', options: Object.keys(ALERT_SUBTYPES), help: 'alert subtypes', label: 'Alert Type', doc: doc('alert-list-widget'), writes: ['type'] },
      { key: 'impact', type: 'choices', options: ['health', 'risk', 'efficiency'], help: 'badges the alerts affect', label: 'Impact', doc: doc('alert-list-widget'), writes: ['alertImpact'] },
      {
        key: 'actions',
        type: 'choices',
        options: ['yes', 'no'],
        help: 'alerts with an action (yes), without (no), or either (default)',
        label: 'Actions',
        doc: doc('alert-list-widget'),
        writes: ['alertAction'],
        read: (src) => { const a = src.config['alertAction']; return Array.isArray(a) && a.length > 0 && a.every((x) => x === 'yes' || x === 'no') ? a.join(',') : undefined; },
      },
      { key: 'definitions', type: 'text', help: 'alert definition ids, comma separated', label: 'Alert Definition', doc: doc('alert-list-widget'), writes: ['alertDefinitions'] },
      { key: 'world', type: 'yesno', help: 'query the whole vSphere World rather than a sent object', label: 'Input Data › Object (vSphere World)', writes: ['resource', 'selfProvider'] },
      S.relationship('children,self', 'alert-list-widget', true),
      S.depth(),
      S.filter('alert-list-widget'),
      S.filterkind('alert-list-widget'),
      S.refresh,
    ],
    alsoWrites: { alertDefinitions: `${CF} and ${QA92}` },
    passthrough: { hierarchyMode: 'an 8.x key (-1 in the two exports that have it) with no option in the 9.x dialog', periodLength: 'only null seen: the alert date range is a per-user state (permDateFilter)' },
    build: (ctx) => {
      const kinds = ctx.s.kinds('kinds');
      const world = ctx.s.yes('world', false);
      const pin = worldOf(kinds[0]);
      const objects = objectsOf(ctx);
      const group = ctx.s.get('group');
      const types = ctx.s.list('types').flatMap((name) => {
        const sub = ALERT_SUBTYPES[name.toLowerCase()];
        return sub === undefined ? [] : [15, 16, 17, 18, 19, 20].map((type) => `${type}_${sub}`);
      });
      const crit = (ctx.s.has('criticality') ? ctx.s.list('criticality') : ['warning', 'immediate', 'critical']).map((c) => CRITICALITY[c.toLowerCase()]).filter((n)              => n !== undefined);
      return {
        refreshInterval: ctx.refreshInterval,
        resource: world ? [{ resourceId: ctx.entries.resource(pin.ref, pin.name), resourceName: pin.name }] : objects,
        refreshContent: { refreshContent: ctx.refreshContent },
        relationshipMode: { relationshipMode: relationshipOf(ctx, [-1, 0]) },
        selfProvider: { selfProvider: world ? false : ctx.selfProvider },
        title: ctx.title,
        mode: objects.length > 0 ? 'resource' : 'all',
        filterMode: filterModeOf(ctx),
        tagFilter: group ? groupFilter(ctx, group, ctx.s.get('grouptype', 'Environment')) : kinds.length > 0 ? kindFilter(ctx, kinds) : null,
        depth: ctx.s.num('depth', 1),
        customFilter: customFilterOf(ctx, kinds[0]),
        criticalityLevel: crit,
        type: types,
        status: ctx.s.get('status', 'active') === 'all' ? [] : [0],
        state: ctx.s.list('controlstate').includes('open') ? [0] : [],
        alertImpact: ctx.s.list('impact'),
        alertAction: ctx.s.list('actions'),
        alertDefinitions: ctx.s.list('definitions').map((id) => ({ id })),
      };
    },
  },
  {
    type: 'ProblemAlertsList',
    label: 'Top Alerts',
    family: 'alert',
    verified: true,
    source: `${CF} _problem_alerts_list_widget; ${NB} (custom_vm_summary), sconyard/vrops-dashboard-Kubernetes_Namespace_Overview; ${REAL}`,
    doc: doc('top-alerts-widget'),
    provides: true,
    needsSubject: true,
    size: { w: 4, h: 5 },
    settings: [
      { key: 'badge', type: 'choice', options: ['health', 'risk', 'efficiency', 'all'], help: 'alerts affecting which badge (default health)', label: 'Impact Badge', doc: doc('top-alerts-widget'), default: 'health', writes: ['impactedBadge'] },
      { key: 'objects', type: 'choice', options: ['self', 'children', 'selfChildren'], help: 'alerts on the object, on its children, or both (default children)', label: 'Input Transformation (triggered on)', doc: doc('top-alerts-widget'), default: 'children', writes: ['triggeredObject'] },
      { key: 'limit', type: 'number', min: 1, max: 50, help: 'how many alerts (default 5)', label: 'Number of Alerts', doc: doc('top-alerts-widget'), default: '5', writes: ['topIssuesDisplayLimit'] },
      { ...S.relationship('self', 'top-alerts-widget'), help: 'the objects the input is turned into (written only when set: most exports leave it out)' },
      S.pin(),
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
        ...(ctx.s.has('relationship') ? { relationshipMode: { relationshipMode: relationshipOf(ctx, 0) } } : {}),
      };
    },
  },
  {
    type: 'IntSummaryAlertVolume',
    label: 'Alert Volume',
    family: 'alert',
    verified: true,
    source: `${CF} _alert_volume_widget; ${QA92} (vendor-template-Home); ${BP} (Alert and Troubleshoot); ${REAL}`,
    doc: doc('alert-volume-widget'),
    provides: false,
    needsSubject: true,
    size: { w: 4, h: 4 },
    settings: [S.pin(), S.refresh],
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
  summaryBadge('IntSummaryHealth', 'Health', { verified: true, source: `${QA92} (qa-9.2.0 export: Health State of the Environment)`, page: 'health-widget', badgeMode: true }),
  summaryBadge('IntSummaryRisk', 'Risk', { verified: true, source: `${SURVEY} (same shape as Health, with badgeMode)`, page: 'risk-widget', deprecated: true, badgeMode: true }),
  summaryBadge('IntSummaryEfficiency', 'Efficiency', { verified: true, source: `${SURVEY} (same shape as Health, with badgeMode)`, page: 'efficiency-widget', deprecated: true, badgeMode: true }),
  summaryBadge('IntSummaryCapacity', 'Capacity Remaining', { verified: true, source: `${BP} (Cluster Capacity Trends and Projections); ${NB} (custom_vm_summary); ${REAL}`, page: 'capacity-remaining-widget' }),
  summaryBadge('IntSummaryTimeRemaining', 'Time Remaining', { verified: true, source: `${NB} (cluster_capacity); ${BP} (Environment Capacity v2); ${REAL}`, page: 'time-remaining-widget' }),
  summaryBadge('IntSummaryWorkload', 'Workload', { verified: true, source: 'vmspot/vROps-Dashboards (TAM Contention Trends)', page: 'workload-widget' }),
  summaryBadge('IntSummaryStress', 'Workload Pattern', {
    verified: true,
    source: `${NB} (custom_vm_summary: config {}); ${REAL} (99 widgets titled for the hourly workload of the last week)`,
    page: 'workload-pattern',
    aliases: ['WorkloadPattern', 'Stress'],
    note: 'The export type is IntSummaryStress (the 8.x Stress widget). Its titles in a real export ("… working hard over the last week", "… workload pattern") match the 9.x Workload Pattern; that it is the same widget is inferred, not documented.',
  }),
  summaryBadge('IntSummaryFaults', 'Faults', { verified: true, source: `${REAL} (one widget: the four common keys, no resource)`, page: 'faults-widget', deprecated: true, resource: false }),
  summaryBadge('IntSummaryAnomalies', 'Anomalies', { verified: false, source: DOCS, page: 'anomalies-widget', deprecated: true, note: 'Type name and config assumed from the IntSummary family.' }),
  summaryBadge('IntSummaryCurrentPolicy', 'Current Policy', { verified: false, source: DOCS, page: 'current-policy-widget', deprecated: true, note: 'Type name and config assumed from the IntSummary family.' }),
  summaryBadge('IntSummaryEnvironment', 'Environment', { verified: false, source: DOCS, page: 'environment-widget', deprecated: true, note: 'Type name and config assumed from the IntSummary family.' }),
  {
    type: 'Skittles',
    label: 'Environment Overview',
    family: 'badge',
    verified: true,
    source: `${SURVEY} §Skittles (mode custom, badge[], custom[] of object types); ${NB} (cost_by_application: config {}); ${REAL}`,
    doc: doc('environment-overview-widget'),
    note: 'The type is Skittles in the export: coloured badge dots per object type.',
    provides: true,
    needsSubject: true,
    size: { w: 6, h: 4 },
    settings: [
      { ...S.kinds(true, ['custom']), label: 'Config › Advanced (object types)', doc: doc('environment-overview-widget') },
      { key: 'badges', type: 'choices', options: ['health', 'risk', 'efficiency'], help: 'which badges (default all three; at least one)', label: 'Badge', doc: doc('environment-overview-widget'), default: 'health,risk,efficiency', writes: ['badge'] },
      S.refresh,
    ],
    passthrough: { mode: 'always custom: the object types are listed in custom[]' },
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
    source: `${CF} _resource_relationship_advanced_widget; ${BP} (Cluster Details v2, Alert and Troubleshoot); ${QA92}; ${REAL}`,
    doc: doc('object-relationship-advanced-widget'),
    provides: true,
    needsSubject: true,
    size: { w: 6, h: 6 },
    settings: [
      S.kinds(false),
      { key: 'depth', type: 'text', options: ['0,1', '0,2', '1,1', '2,2', '3,3'], help: 'parents depth,children depth (default 2,2)', label: 'Parents Depth / Children Depth', doc: doc('object-relationship-advanced-widget'), default: '2,2', writes: ['depth'] },
      { key: 'traversal', type: 'text', options: ['vSphere Hosts and Clusters-VMWARE-vSphere World', 'vSphere Storage-VMWARE-vSphere World'], help: 'the inventory tree it starts from (default vSphere Hosts and Clusters-VMWARE-vSphere World)', label: 'Inventory trees', doc: doc('object-relationship-advanced-widget'), default: 'vSphere Hosts and Clusters-VMWARE-vSphere World', writes: ['traversalSpecId'] },
      { key: 'rows', type: 'number', min: 1, max: 100, help: 'objects per page (default 5)', label: 'Page Size', doc: doc('object-relationship-advanced-widget'), default: '5', writes: ['paginationNumber'] },
      { key: 'first', type: 'yesno', help: 'select the first object on open (default no)', label: 'Auto Select First Row', default: 'no', writes: ['selectFirstRow'] },
      { ...S.pin(['resourceId', 'resourceName']), seenElsewhere: `${QA92} and the same export (resource:id, SDDC Health)`, read: (src) => { const f = src.entries.resourceOf(String(src.config['resourceId'] ?? '')); return f && !/[;,]/.test(f.name) && !(f.ref.adapterKind === 'VMWARE' && f.ref.resourceKind === 'vSphere World') ? `${kindAlias(f.ref)}:${f.name}` : undefined; } },
      S.filter('object-relationship-advanced-widget'),
      S.filterkind('object-relationship-advanced-widget'),
      S.refresh,
    ],
    alsoWrites: { paginationNumber: `${CF} and ${QA92}`, selectFirstRow: `${CF} and ${QA92}` },
    build: (ctx) => {
      const pin = pinOf(ctx, undefined);
      const pinned = ctx.selfProvider && ctx.s.has('pin');
      return {
        resourceId: pinned ? ctx.entries.resource(pin.ref, pin.name) : null,
        refreshInterval: ctx.refreshInterval,
        traversalSpecId: ctx.s.get('traversal', 'vSphere Hosts and Clusters-VMWARE-vSphere World'),
        refreshContent: { refreshContent: ctx.refreshContent },
        resourceName: pinned ? pin.name : null,
        title: ctx.title,
        filterMode: filterModeOf(ctx),
        tagFilter: ctx.s.kinds('kinds').length > 0 ? kindFilter(ctx, ctx.s.kinds('kinds')) : null,
        paginationNumber: ctx.s.num('rows', 5),
        depth: ctx.s.get('depth', '2,2'),
        customFilter: customFilterOf(ctx),
        selectFirstRow: { selectFirstRow: ctx.s.yes('first', false) },
        selfProvider: { selfProvider: ctx.selfProvider },
      };
    },
  },
  {
    type: 'ResourceRelationship',
    label: 'Object Relationship',
    family: 'relationship',
    verified: true,
    source: `${BP} (ESX Host Details, vCenter Server Health); vmwarecode/vROPs-8.0---6.7.x-Horizon-Adapter-Dashboard-Content-Pack; ${REAL}`,
    doc: doc('object-relationship-widget'),
    provides: true,
    needsSubject: true,
    size: { w: 6, h: 5 },
    settings: [
      S.kinds(false),
      { key: 'nodesize', type: 'number', min: 8, max: 64, help: 'icon size in pixels (default: automatic, null)', label: 'Node Size', doc: doc('object-relationship-widget'), writes: ['nodeSize'], seenElsewhere: `${BP} (nodeSize 18)` },
      { key: 'autozoom', type: 'yesno', help: 'zoom once to a fixed node size (default no)', label: 'Auto Zoom to Fixed Node Size', doc: doc('object-relationship-widget'), default: 'no', writes: ['autoZoom'] },
      { ...S.pin(['resourceId', 'resourceName']), seenElsewhere: 'the Object Relationship (Advanced) of the same export', read: (src) => { const f = src.entries.resourceOf(String(src.config['resourceId'] ?? '')); return f && !/[;,]/.test(f.name) ? `${kindAlias(f.ref)}:${f.name}` : undefined; } },
      S.filter('object-relationship-widget'),
      S.filterkind('object-relationship-widget'),
      S.refresh,
    ],
    build: (ctx) => {
      const pin = pinOf(ctx, undefined);
      const pinned = ctx.selfProvider && ctx.s.has('pin');
      return {
        filterMode: filterModeOf(ctx),
        tagFilter: ctx.s.kinds('kinds').length > 0 ? kindFilter(ctx, ctx.s.kinds('kinds')) : null,
        resourceId: pinned ? ctx.entries.resource(pin.ref, pin.name) : null,
        nodeSize: ctx.s.has('nodesize') ? ctx.s.num('nodesize', 18) : null,
        refreshInterval: ctx.refreshInterval,
        autoZoom: { autoSize: ctx.s.yes('autozoom', false) },
        refreshContent: { refreshContent: ctx.refreshContent },
        customFilter: customFilterOf(ctx),
        resourceName: pinned ? pin.name : null,
        selfProvider: { selfProvider: ctx.selfProvider },
        title: ctx.title,
      };
    },
  },
  {
    type: 'TopologyGraph',
    label: 'Topology Graph',
    family: 'relationship',
    verified: true,
    source: `${BP} (Legacy MSSQL Dashboards: MS-SQL-Database.json); ${REAL}`,
    doc: doc('topology-widget'),
    note: 'Writes the configuration file’s parent and child relationships over the vSphere Hosts and Clusters traversal; relationships a management pack adds are kept as exported when loaded.',
    provides: true,
    needsSubject: true,
    size: { w: 6, h: 6 },
    settings: [
      { key: 'depth', type: 'number', min: 1, max: 10, help: 'levels shown (default 2)', label: 'Degree of separation', doc: doc('topology-widget'), default: '2', writes: ['depth'] },
      { key: 'exploration', type: 'choice', options: ['node', 'path'], help: 'explore from one object (node, the default) or between two (path)', label: 'Exploration Mode', doc: doc('topology-widget'), default: 'node', writes: ['mode'], read: readChoice('mode', ['path'], 'node') },
      { key: 'layout', type: 'choice', options: ['force', 'hierarchical'], help: 'Graph (force, the default) or Hierarchical', label: 'Layout', doc: doc('topology-widget'), default: 'force', writes: ['custom'] },
      { key: 'treetype', type: 'yesno', help: 'a tree view for the hierarchical layout (default no)', label: 'Tree type', doc: doc('topology-widget'), default: 'no', writes: ['treeType'], read: readFlag('treeType', 'treeType', false) },
      { key: 'configfile', type: 'text', options: ['defaultTopologyGraphConfig.xml'], help: 'the relationship definition file (default defaultTopologyGraphConfig.xml)', label: 'Configuration File', doc: doc('topology-widget'), default: 'defaultTopologyGraphConfig.xml', writes: ['custom'] },
      { ...S.pin(), read: (src) => { const r = src.config['resource']; const f = rec(r) ? src.entries.resourceOf(String(r['resourceId'] ?? '')) : undefined; return f && !/[;,]/.test(f.name) ? `${kindAlias(f.ref)}:${f.name}` : undefined; } },
      S.metricconfig('topology-widget'),
      S.refresh,
    ],
    passthrough: {
      resources: 'the two objects Path Exploration runs between ([{resourceName: ""}, …] until they are picked)',
      filterMode: 'always {leafExpand: true}: leaf objects expand in the graph',
    },
    build: (ctx) => {
      const pin = pinOf(ctx, undefined);
      const pinned = ctx.selfProvider && ctx.s.has('pin');
      return {
        custom: [
          {
            lightWeightRelationships: [
              { id: 'extModel1-1', key: 'widget.topologyGraph.parent', lineStyle: 'solid', name: '', propKeyPrefix: '', relationship: '~child', subType: '', type: '~child' },
              { id: 'extModel1-2', key: 'widget.topologyGraph.child', lineStyle: 'solid', name: '', propKeyPrefix: '', relationship: 'child', subType: '', type: 'child' },
            ],
            selectedConfigFile: ctx.s.get('configfile', 'defaultTopologyGraphConfig.xml'),
            selectedLayoutType: ctx.s.get('layout', 'force'),
            travSpecs: [{ description: 'vSphere Hosts and Clusters', id: 'extModel2-1', key: 'vSphere Hosts and Clusters-VMWARE-vSphere World', name: 'vSphere Hosts and Clusters', relations: ['~child', 'child'] }],
          },
        ],
        depth: ctx.s.num('depth', 2),
        filterMode: { leafExpand: true },
        mode: ctx.s.get('exploration', 'node'),
        refreshContent: { refreshContent: ctx.refreshContent },
        refreshInterval: ctx.refreshInterval,
        resInteractionMode: ctx.s.get('metricconfig') || null,
        resource: pinned ? { resourceId: ctx.entries.resource(pin.ref, pin.name), resourceName: pin.name } : { resourceName: '' },
        resources: [{ resourceName: '' }, { resourceName: '' }],
        selfProvider: { selfProvider: ctx.selfProvider },
        title: ctx.title,
        treeType: { treeType: ctx.s.yes('treetype', false) },
      };
    },
  },
  {
    type: 'MetricPicker',
    label: 'Metric Picker',
    family: 'picker',
    verified: true,
    source: `${BP} (Alert and Troubleshoot, Troubleshooting VMs v3); ${REAL}`,
    doc: doc('metric-picker-widget'),
    note: 'It sends a metric, not an object: a widget that receives from it is wired with interaction type metricId, as the exports have it. Its "common", "collecting" and properties switches are per-user states.',
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
    source: `${SURVEY} §TagPicker (config is refreshInterval and refreshContent); ${REAL} (91 widgets, every one with config {})`,
    doc: doc('tag-picker-widget'),
    provides: true,
    needsSubject: false,
    size: { w: 3, h: 6 },
    settings: BLANK_ONLY,
    alsoWrites: { refreshInterval: SURVEY, refreshContent: SURVEY },
    build: (ctx) => ({ refreshInterval: ctx.refreshInterval, refreshContent: { refreshContent: ctx.refreshContent } }),
  },
  {
    type: 'Geo',
    label: 'Geo',
    family: 'other',
    verified: true,
    source: `${SURVEY} §Geo; ${REAL} (one widget: tag and Advanced filters)`,
    doc: `${DOCS90}geo-widget.html`,
    note: 'In VCF Operations 9.0’s widget list, not 9.1’s. Objects appear only when their Geo Location tag is set.',
    provides: true,
    needsSubject: false,
    size: { w: 6, h: 6 },
    settings: [S.kinds(false), { ...S.filter('geo-widget'), doc: `${DOCS90}geo-widget.html` }, { ...S.filterkind('geo-widget'), doc: `${DOCS90}geo-widget.html` }, S.refresh],
    build: (ctx) => {
      const kinds = ctx.s.kinds('kinds');
      return { ...common(ctx), filterMode: filterModeOf(ctx), tagFilter: kinds.length > 0 ? kindFilter(ctx, kinds) : null, customFilter: customFilterOf(ctx, kinds[0]) };
    },
  },
  {
    type: 'LogAnalysis',
    label: 'Log Analysis',
    family: 'logs',
    verified: true,
    source: `${BP} (Troubleshooting VMs v4: Log Analysis for selected VM and parent ESX Host)`,
    doc: doc('log-analysis-widget'),
    note: 'Needs VCF Operations for logs integrated. The export seen had an empty query; query= is written as its search text, which is not confirmed.',
    provides: false,
    needsSubject: true,
    size: { w: 12, h: 6 },
    settings: [
      { key: 'chart', type: 'choice', options: ['column', 'bar', 'line', 'area', 'pie', 'scalar'], help: 'chart type (default column)', label: 'Visualization Details › chart type', doc: doc('log-analysis-widget'), default: 'column', writes: ['chartType'] },
      { key: 'show', type: 'choice', options: ['all', 'chart', 'events'], help: 'what the widget shows (default all)', label: 'Visualization Details › view mode', doc: doc('log-analysis-widget'), default: 'all', writes: ['liViewMode'] },
      { key: 'relationship', type: 'choice', options: ['self', 'children', 'parents'], help: 'logs of the object, its children, or its parents too (default parents)', label: 'Input Transformation', default: 'parents', writes: ['relationshipMode'] },
      { key: 'query', type: 'text', help: 'search text', label: 'Query Details › keyword search', doc: doc('log-analysis-widget'), writes: ['queryFilter_searchtext'] },
      { key: 'rows', type: 'number', min: 1, max: 1000, help: 'events returned (default 50)', label: 'Query Details (events)', default: '50', writes: ['queryFilter'] },
      S.refresh,
    ],
    passthrough: { liOverTime: 'the aggregation over time (Aggregation Details) the logs integration keeps', liAggregationFunction: 'the aggregation function (Aggregation Details): count', liQueryMode: 'the query mode the logs integration keeps (1)' },
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
    doc: doc('recommended-actions-widget'),
    note: 'Scope, object tabs and badge are chosen on the widget itself, not in its configuration.',
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
    doc: doc('data-collection-results-widget'),
    note: 'Which actions it offers depends on the object’s adapter; the default action per object type is set in the editor.',
    provides: false,
    needsSubject: true,
    size: { w: 6, h: 5 },
    settings: [
      { key: 'oninteraction', type: 'yesno', help: 'start a new data collection when the sending widget’s selection changes (default no)', label: 'Start new data collection on interaction change', doc: doc('data-collection-results-widget'), default: 'no', writes: ['dataCollectionOnInteraction'], read: readFlag('dataCollectionOnInteraction', 'dataCollectionOnInteraction', false) },
      S.refresh,
    ],
    passthrough: { dataCollectionDefaultActions: 'the default action per object type (Defaults), picked in the editor from the adapter’s actions', dataCollectionSelectedResource: 'the Selected Object, picked in the editor' },
    build: (ctx) => ({ ...common(ctx), dataCollectionDefaultActions: [], dataCollectionOnInteraction: { dataCollectionOnInteraction: ctx.s.yes('oninteraction', false) }, dataCollectionSelectedResource: {} }),
  },
  {
    type: 'ContainerDetails',
    label: 'Container Details',
    family: 'other',
    verified: true,
    source: 'sconyard/vrops-dashboard-Kubernetes_Namespace_Overview (config {})',
    doc: doc('container-details-widget'),
    note: 'The only export seen had config {}: Mode (Compact or Large) and the object are the docs’ options, their keys unverified.',
    provides: false,
    needsSubject: true,
    size: { w: 6, h: 5 },
    settings: [{ key: 'mode', type: 'choice', options: ['compact', 'large'], help: 'graph size (written only when set)', label: 'Mode', doc: doc('container-details-widget'), writes: ['mode'], unverified: true }],
    build: (ctx) => (ctx.s.has('mode') ? { mode: ctx.s.get('mode') } : {}),
  },
  {
    type: 'ContainerOverview',
    label: 'Container Overview',
    family: 'other',
    verified: false,
    source: `${SURVEY} (type counted on a live instance, config not shown); ${DOCS}`,
    doc: doc('container-overview-widget'),
    note: 'Config keys follow the other widgets; Mode’s key and values are unverified.',
    deprecated: true,
    provides: true,
    needsSubject: false,
    size: { w: 6, h: 5 },
    settings: [{ key: 'mode', type: 'choice', options: ['object', 'objectType'], help: 'observe chosen objects or an object type', label: 'Mode', doc: doc('container-overview-widget'), writes: ['mode'], unverified: true }, S.refresh],
    build: (ctx) => ({ ...common(ctx), ...(ctx.s.has('mode') ? { mode: ctx.s.get('mode') } : {}) }),
  },
  {
    type: 'Forensics',
    label: 'Forensics',
    family: 'chart',
    verified: false,
    source: `${DOCS}; VCF 9.1 "Forensics Widget" (percentile, metric, object)`,
    doc: doc('forensics-widget'),
    note: 'Type name and config keys follow the other metric widgets; configure it in the editor if it opens empty.',
    provides: false,
    needsSubject: true,
    size: { w: 6, h: 5 },
    settings: [
      { ...S.kind(), writes: ['resourceKindId'], unverified: true },
      { ...S.metric(), writes: ['metricKey'], unverified: true },
      { key: 'percentile', type: 'number', min: 1, max: 100, help: 'marks the share of data above or below a value, e.g. 90', label: 'Percentile', doc: doc('forensics-widget'), writes: ['percentileValue'], unverified: true },
      { ...S.period(), unverified: true },
      S.refresh,
    ],
    build: (ctx) => {
      const kind = ctx.s.kind('kind', KIND_ALIASES['vm']) ;
      return { ...common(ctx), metricKey: ctx.s.get('metric'), resourceKindId: ctx.entries.kind(kind), periodLength: ctx.s.get('period', 'last7Days'), ...(ctx.s.has('percentile') ? { percentileValue: ctx.s.num('percentile', 90) } : {}) };
    },
  },
  {
    type: 'WeatherMap',
    label: 'Weather Map',
    family: 'chart',
    verified: false,
    source: DOCS,
    doc: doc('weather-map-widget'),
    deprecated: true,
    note: 'Deprecated in VCF 9. Type name and config keys follow the other metric widgets; none of its options’ keys has been seen in an export.',
    provides: false,
    needsSubject: true,
    size: { w: 6, h: 5 },
    settings: [
      { ...S.kind(), writes: ['resourceKindId'], unverified: true },
      { ...S.metric(), writes: ['metricKey'], unverified: true },
      { ...S.period('Metric History: the time window, from the last hour to the last 30 days'), unverified: true },
      { key: 'every', type: 'number', min: 1, max: 1440, help: 'minutes between redraws of the cached data', label: 'Redraw Rate', doc: doc('weather-map-widget'), writes: ['regenerationTime'], unverified: true },
      { key: 'sortby', type: 'choice', options: ['name', 'metricValue'], help: 'object name or metric value', label: 'Sort by', doc: doc('weather-map-widget'), writes: ['sortBy'], unverified: true },
      { key: 'min', type: 'number', help: 'lowest value on the colour scale (blank: automatic)', label: 'Color › Min', doc: doc('weather-map-widget'), writes: ['minValue'], unverified: true },
      { key: 'max', type: 'number', help: 'highest value on the colour scale (blank: automatic)', label: 'Color › Max', doc: doc('weather-map-widget'), writes: ['maxValue'], unverified: true },
      S.refresh,
    ],
    build: (ctx) => {
      const kind = ctx.s.kind('kind', KIND_ALIASES['vm']) ;
      return {
        ...common(ctx),
        metricKey: ctx.s.get('metric'),
        resourceKindId: ctx.entries.kind(kind),
        periodLength: ctx.s.get('period', 'last24Hour'),
        ...(ctx.s.has('every') ? { regenerationTime: ctx.s.num('every', 5) } : {}),
        ...(ctx.s.has('sortby') ? { sortBy: ctx.s.get('sortby') } : {}),
        ...(ctx.s.has('min') ? { minValue: ctx.s.num('min', 0) } : {}),
        ...(ctx.s.has('max') ? { maxValue: ctx.s.num('max', 100) } : {}),
      };
    },
  },
  {
    type: 'WorkloadBalance',
    label: 'DRS Cluster Settings',
    family: 'other',
    verified: true,
    source: `${REAL} (one widget: badge.utilizationSource, resourceKindId[], a tree-node resource); the type name is the one this toolkit’s own reader knows (src/aria/aria.ts)`,
    doc: doc('drs-cluster-settings-widget'),
    deprecated: true,
    note: 'The one export instance was titled "Capacity Utilization"; that WorkloadBalance is the widget the 9.x list calls DRS Cluster Settings is this toolkit’s mapping, not documented.',
    provides: false,
    needsSubject: true,
    size: { w: 6, h: 5 },
    settings: [{ ...S.kinds(false, ['resourceKindId']), label: 'Object types' }, S.refresh],
    passthrough: {
      badge: 'always {utilizationSource: "workload"} in the export',
      resource: 'an 8.x navigation-tree node for the object it was opened on',
    },
    build: (ctx) => ({ badge: { utilizationSource: 'workload' }, refreshInterval: ctx.refreshInterval, refreshContent: { refreshContent: ctx.refreshContent }, resourceKindId: ctx.s.kinds('kinds').map((k) => ctx.entries.kind(k)), selfProvider: { selfProvider: ctx.selfProvider }, title: ctx.title }),
  },
  {
    type: 'EnvironmentStatus',
    label: 'Environment Status',
    family: 'badge',
    verified: false,
    source: DOCS,
    doc: doc('environment-status-widget'),
    deprecated: true,
    note: 'Its Output Data sections (objects, metrics, applications, alerts, analytics, users) are picked in the editor; their keys are unknown.',
    provides: false,
    needsSubject: false,
    size: { w: 4, h: 4 },
    settings: BLANK_ONLY,
    build: (ctx) => common(ctx),
  },
  {
    type: 'ParetoChart',
    label: 'Anomaly Breakdown',
    family: 'chart',
    verified: true,
    source: `${REAL} (two widgets titled Anomaly Breakdown: mode {mode: single}, barsCount, tagFilter, resource)`,
    doc: doc('anomaly-breakdown-widget'),
    aliases: ['AnomalyBreakdown'],
    note: 'The export type is ParetoChart. Mode multiple is the docs’ "multiple objects"; only single has been seen.',
    provides: false,
    needsSubject: true,
    size: { w: 6, h: 5 },
    settings: [
      { key: 'mode', type: 'choice', options: ['single', 'multiple'], help: 'one object or several (default single)', label: 'Mode', doc: doc('anomaly-breakdown-widget'), default: 'single', writes: ['mode'], read: (src) => (at(src.config, 'mode', 'mode') === 'multiple' ? 'multiple' : undefined) },
      { key: 'show', type: 'number', min: 1, max: 100, help: 'objects shown in multiple mode (default 10)', label: 'Show', doc: doc('anomaly-breakdown-widget'), default: '10', writes: ['barsCount'], read: readNum('barsCount', 10) },
      { ...S.kinds(false), label: 'Output Filter › Basic', doc: doc('anomaly-breakdown-widget'), seenElsewhere: 'the Object List’s tagFilter in the same export' },
      { ...S.pin(), seenElsewhere: 'the Top Alerts and Alert Volume widgets ({resourceId, resourceName})', read: (src) => { const r = src.config['resource']; const f = rec(r) ? src.entries.resourceOf(String(r['resourceId'] ?? '')) : undefined; return f && !/[;,]/.test(f.name) ? `${kindAlias(f.ref)}:${f.name}` : undefined; } },
      S.refresh,
    ],
    build: (ctx) => {
      const pin = pinOf(ctx, undefined);
      const kinds = ctx.s.kinds('kinds');
      return {
        mode: { mode: ctx.s.get('mode', 'single') },
        tagFilter: kinds.length > 0 ? kindFilter(ctx, kinds) : null,
        barsCount: ctx.s.num('show', 10),
        refreshInterval: ctx.refreshInterval,
        resource: ctx.selfProvider ? { resourceId: ctx.entries.resource(pin.ref, pin.name), resourceName: pin.name } : null,
        refreshContent: { refreshContent: ctx.refreshContent },
        selfProvider: { selfProvider: ctx.selfProvider },
        title: ctx.title,
      };
    },
  },
  {
    type: 'PromQLViewer',
    label: 'PromQL Viewer',
    family: 'chart',
    verified: false,
    source: `${DOCS} (new in 9.1)`,
    doc: doc('promql-widget'),
    note: 'New in VCF Operations 9.1 and in no export yet: the type name PromQLViewer and every config key are inferred from the documentation. Build it, then open it in the editor and save it once.',
    provides: false,
    needsSubject: false,
    size: { w: 6, h: 5 },
    settings: [
      { key: 'source', type: 'choice', options: ['vcenter', 'nsx'], help: 'in Self Provider mode: vCenter/vSAN (the default) or NSX of the domain; otherwise the VCF instance', label: 'Output Data › Source', doc: doc('promql-widget'), default: 'vcenter', writes: ['source'], unverified: true },
      { key: 'query', type: 'rest', help: 'the full PromQL expression (the rest of the cell)', label: 'Output Data › Query', doc: doc('promql-widget/promql-queries'), required: true, writes: ['query'], unverified: true },
      S.refresh,
    ],
    build: (ctx) => ({ ...common(ctx), source: ctx.s.get('source', 'vcenter'), query: ctx.s.get('query') }),
  },
];

/** The collapsed state is a widget key, and the 9.x description and details link are every widget’s (a Section has its own). */
export const WIDGET_TYPES                        = RAW_TYPES.map((type) =>
  type.type === 'Section'
    ? type
    : {
        ...type,
        settings: [...type.settings, ...COMMON_TAIL],
        alsoWrites: { ...(type.alsoWrites ?? {}), description: `${QA92} (9.2: Widget Description)`, viewDetails: `${QA92} (9.2: Details URL)` },
        build: (ctx               ) => tail(ctx, type.build(ctx)),
      },
);

const BY_TYPE = new Map(WIDGET_TYPES.map((type) => [type.type.toLowerCase(), type]));
const BY_LABEL = new Map(WIDGET_TYPES.map((type) => [type.label.toLowerCase(), type]));
const BY_ALIAS = new Map(WIDGET_TYPES.flatMap((type) => (type.aliases ?? []).map((alias) => [alias.toLowerCase(), type]         )));

/** A widget type by its export name, its name in the widget list ("Top-N", "Object List"), or an older name. */
export function widgetType(name        )                         {
  const key = name.trim().toLowerCase();
  return BY_TYPE.get(key) ?? BY_LABEL.get(key) ?? BY_ALIAS.get(key);
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
      case 'filter':
        for (const problem of parseFilter(raw).problems) errors.push(`${setting.key}: ${problem}`);
        break;
      case 'objects':
        for (const part of settings.list(setting.key)) {
          const colon = part.indexOf(':');
          if (colon <= 0 || !parseKind(part.slice(0, colon)) || !part.slice(colon + 1).trim()) errors.push(`${setting.key}: "${part}" is not type:Object name (vm:web-01)`);
        }
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

/** The dashboard time state the exports carry (permDashboardTime_dashboard_<id>), for the ranges seen in them. */
export const DASHBOARD_TIME_RANGES                                   = {
  lastHour: 'o%3AdateRange%3Ds%253AlastHour%5EdateRangeText%3Ds%253A1H',
  last6Hour: 'o%3AdateRange%3Ds%253Alast6Hour%5EdateRangeText%3Ds%253A6H',
  last24Hour: 'o%3AdateRange%3Ds%253Alast24Hour%5EdateRangeText%3Ds%253A24H',
  last7Days: 'o%3AdateRange%3Ds%253Alast7Days%5EdateRangeText%3Ds%253A7D',
  last30Days: 'o%3AdateRange%3Ds%253Alast30Days%5EdateRangeText%3Ds%253ALast%252030%2520days',
  last90Days: 'o%3AdateRange%3Ds%253Alast90Days%5EdateRangeText%3Ds%253ALast%252090%2520days',
  lastYear: 'o%3AdateRange%3Ds%253AlastYear%5EdateRangeText%3Ds%253ALast%2520year',
};

/**
 * columnProportion values a dashboard export carries. It is the 8.x
 * column editor's split, kept beside the 12-column grid; columnCount is 1 on
 * every dashboard read (303 of 303), gridsterMaxColumns 12.
 */
export const COLUMN_PROPORTIONS                                                                = [
  { value: '1', label: 'One column (1)' },
  { value: '1-1', label: 'Two equal columns (1-1)' },
  { value: '0.5-0.5', label: 'Two halves (0.5-0.5)' },
  { value: '0.5', label: 'Half width (0.5)' },
  { value: '0.48-0.52', label: 'Two columns, 48/52 (0.48-0.52)' },
];

/** An object type as a row writes it: its alias where it has one ("cluster"), else the vSphere kind or Adapter/Kind. */
export function kindAlias(kind         )         {
  for (const [alias, ref] of Object.entries(KIND_ALIASES)) if (ref.adapterKind === kind.adapterKind && ref.resourceKind === kind.resourceKind) return alias;
  return kind.adapterKind === 'VMWARE' ? kind.resourceKind : `${kind.adapterKind}/${kind.resourceKind}`;
}

/**
 * Every dashboard-level key an export holds, and where the builder gets it:
 * a field of the dashboard form, or kept exactly as the export had it.
 */
export const DASHBOARD_KEYS                                                                                = {
  id: { field: 'the dashboard name (a new id derived from it), or the loaded export’s own id' },
  name: { field: 'dashboard_name and folder' },
  namePath: { field: 'folder' },
  description: { field: 'description' },
  shared: { field: 'sharing' },
  hidden: { field: 'hidden' },
  disabled: { field: 'disabled' },
  homeTab: { field: 'home_tab' },
  locked: { field: 'locked' },
  autoswitchEnabled: { field: 'autoswitch' },
  autoswitchDelay: { field: 'autoswitch_delay' },
  columnProportion: { field: 'column_proportion' },
  states: { field: 'time_range (permDashboardTime_dashboard_<id>)' },
  dashboardNavigations: { field: 'navigations' },
  widgetInteractions: { field: 'each row’s Receives from' },
  widgets: { field: 'the widget rows' },
  columnCount: { kept: 'always 1 (303 of 303 dashboards): the grid replaced the 8.x columns' },
  gridsterMaxColumns: { kept: 'always 12: the grid’s width' },
  temporary: { kept: 'always false in exports' },
  rank: { kept: 'always 0 in exports: the order Manage Dashboards keeps' },
  creationTime: { kept: 'set by the appliance on import' },
  lastUpdateTime: { kept: 'set by the appliance on save' },
  userId: { kept: 'the owner, set to the importing user' },
  lastUpdateUserId: { kept: 'the last editor, set by the appliance' },
  importAttempts: { kept: 'the appliance’s own import bookkeeping' },
  importComplete: { kept: 'the appliance’s own import bookkeeping' },
  editAllowed: { kept: 'whether the viewer may edit (a 9.2 export has it): Manage Dashboard Sharing › Editable' },
  adapterName: { kept: 'the management pack that ships the dashboard' },
  docCenterKey: { kept: 'the help topic of a dashboard Broadcom ships' },
  videoKey: { kept: 'the tutorial video of a dashboard Broadcom ships' },
  videoPlaylistKey: { kept: 'the tutorial playlist of a dashboard Broadcom ships' },
  entryKeys: { kept: 'the entries a shipped dashboard refers to, kept with the dashboard' },
};
