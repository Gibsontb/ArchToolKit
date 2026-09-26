/**
 * The Application Migration panes' model (WP-UI-D): everything the panes do
 * to the plan, as pure functions over `Plan`, so the rules are tested without
 * a DOM and every pane shares one reading of an app.
 *
 * The engines are WP-19's (recommend, choose, compare, generate), WP-23's
 * (sizing), WP-16's (patterns) and WP-18's (translation); nothing here scores,
 * sizes or translates on its own. This file only:
 *  - finds an app by its `#app:<slug>` slug and reads its catalogue row;
 *  - reads the platform an app is shown on (its choice, else its
 *    recommendation) and the variant there, creating it only when an edit
 *    needs it (`ensureVariant`), so looking never writes the plan;
 *  - adds, edits and removes components (pattern, resource, config);
 *  - reads and writes the sizing grid's overrides and the sizing policy;
 *  - computes readiness (100 − 25 × blockers − 10 × EOL − 10 × unknown type)
 *    and says it in the provider's own vocabulary;
 *  - builds the app stack's pipeline beside the stack.
 */

import { error, info, warning,              } from '../../core/findings.js';
                                                                      
import { defaultValues } from '../../kit/blueprint.js';
import { AWS_DB_INSTANCE_CLASS_GROUPS, AWS_INSTANCE_TYPE_GROUPS, AZURE_VM_SIZE_GROUPS, GCP_MACHINE_TYPE_GROUPS, OCI_SHAPE_GROUPS } from '../../kit/sizes-data.js';
import { instanceSpec,                   } from '../../kit/instance-specs.js';
import { appDatabases, appPlanOf, appWorkloads, componentId, defaultAppPlan, ensureVariant, findApp, templateFor, withAppPlan } from '../../multicloud/plan/apps/components.js';
import { chooseAppPlatform, recommendApp, recommendationDecision } from '../../multicloud/plan/apps/recommend.js';
import { appSlice } from '../../multicloud/plan/apps/slice.js';
import { addressOf } from '../../multicloud/plan/apps/translate.js';
import { appComplexity } from '../../multicloud/plan/governance/complexity.js';
import { PROVIDER_TERMS } from '../../multicloud/plan/methodology.js';
import {
  DEFAULT_SIZING_POLICY, PLATFORM_VALUES, SOURCE_PLATFORM_OPTIONS, defaultSizing, labelOf, slugName,
} from '../../multicloud/plan/options.js';
import { supportStatus } from '../../multicloud/plan/os.js';
import { rankTierPatterns, workloadTypeOf,                        } from '../../multicloud/plan/patterns/index.js';
import { sizeComponent } from '../../multicloud/plan/sizing/index.js';
             
                                                                                                                  
                                                          
                                        
import { rowOf,                        } from '../../terraform/equivalence.js';
import { appSlug } from '../page-modes.js';

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

/** The Compare columns, in order: the four clouds and VMware Cloud Foundation. */
export const COMPARE_PLATFORMS                      = PLATFORM_VALUES;

/** Platform names as the app panes show them (VCF 9.1 naming; "Google Cloud (GCP)"). */
export const PLATFORM_NAME                                     = {
  aws: 'AWS',
  azure: 'Azure',
  google: 'Google Cloud (GCP)',
  oci: 'OCI',
  vmware: 'VMware Cloud Foundation (VCF)',
};

export const PLATFORM_CHOICES                                                                  = COMPARE_PLATFORMS.map((p) => ({ value: p, label: PLATFORM_NAME[p] }));

// ---------------------------------------------------------------------------
// Finding an app
// ---------------------------------------------------------------------------

/** The app a `#app:<slug>` names: by the slug of its id, else by name or id. */
export function appBySlug(plan                    , slug        )                  {
  const s = slug.trim().toLowerCase();
  if (!s) return undefined;
  return plan.apps.find((a) => appSlug(a.id) === s) ?? findApp(plan, slug);
}

/** `#app:<slug>[/<tab>]`, split. */
export function parseAppArg(arg        )                                {
  const [slug = '', tab = ''] = arg.split('/');
  return { slug: decodeURIComponent(slug), tab };
}

export const appHash = (app                 , tab         )         => `app:${appSlug(app.id)}${tab ? `/${tab}` : ''}`;

/** The app's plan, or a fresh draft (not stored). */
export function appPlanOrDraft(plan      , app     )          {
  return appPlanOf(plan, app.id) ?? defaultAppPlan(app);
}

// ---------------------------------------------------------------------------
// Recommendation and platform
// ---------------------------------------------------------------------------

/**
 * An app's recommendation, read the way Compare reads it: from its slice,
 * with its own choice left out (otherwise the choice would recommend itself).
 */
export function recommendationOf(plan      , appId        )                    {
  const app = findApp(plan, appId);
  if (!app) return { app: appId, perPlatform: [], margin: 0, tooClose: true };
  const slice = appSlice(withAppPlan(plan, appPlanOrDraft(plan, app)), [app.id]);
  return recommendApp(slice, recommendationDecision(slice), app.id);
}

/** Every app's recommendation (one slice each, so the catalogue agrees with Compare). */
export function recommendationsOf(plan      )                                    {
  return Object.fromEntries(plan.apps.map((a) => [a.id, recommendationOf(plan, a.id)]));
}

/** The platform an app is shown on: its choice, else its recommendation, else the first allowed platform. */
export function shownPlatform(plan      , appId        , rec                    )           {
  const ap = appPlanOf(plan, appId);
  return ap?.platform ?? rec?.recommended ?? ap?.recommendation?.platform ?? plan.requirements.allowed[0] ?? 'aws';
}

/** "Use recommendation" for several apps: each is placed on its recommended platform. Apps without one are named. */
export function useRecommendation(plan      , appIds                   , recs                                             )                                                                     {
  let out = plan;
  const placed           = [];
  const skipped           = [];
  const log           = [];
  for (const id of appIds) {
    const app = findApp(out, id);
    const rec = app ? recs[app.id] : undefined;
    if (!app || !rec?.recommended) {
      if (app) skipped.push(app.name);
      continue;
    }
    const r = chooseAppPlatform(out, app.id, rec.recommended);
    out = r.plan;
    placed.push(app.name);
    if (r.logEntry) log.push(r.logEntry);
  }
  return { plan: out, placed, skipped, log };
}

// ---------------------------------------------------------------------------
// The catalogue
// ---------------------------------------------------------------------------

                               
                      
                        
                        
                        
                           
                         
                               
                                     
                           
                             
                           
                                  
                             
                          
                             
                                     
                                                                         
                              
 

/** The A.10.17 complexity, or a zero score when the plan has data the scorer cannot read (an unknown OS id). */
export function safeComplexity(plan      , name        , on        )                                   {
  try {
    return appComplexity(plan, name, { on });
  } catch {
    return { app: name, score: 0, band: 'Low', criticalityBand: 'Low', risk: 'Low', factors: [], source: '' };
  }
}

export function catalogueRows(plan      , recs                                             , on        )                 {
  return plan.apps.map((a)               => {
    const ap = appPlanOrDraft(plan, a);
    const ws = appWorkloads(plan, a).filter((w) => !w.synthetic);
    const dbs = appDatabases(plan, a);
    const origin = ap.origin;
    const sources = origin === 'new'
      ? 'new'
      : [...new Set(ws.map((w) => labelOf(SOURCE_PLATFORM_OPTIONS, w.origin ?? 'vsphere')))].sort().join(', ');
    const rec = recs[a.id];
    const cx = safeComplexity(plan, a.name, on);
    const p = ap.platform ?? rec?.recommended;
    return {
      id: a.id, slug: appSlug(a.id), name: a.name, kind: a.kind ?? 'unknown', pattern: a.pattern ?? 'generic', owner: a.owner ?? '',
      criticality: a.criticality, origin, servers: ws.length, databases: dbs.length, sources,
      ...(rec?.recommended ? { recommended: rec.recommended } : {}),
      ...(ap.platform ? { chosen: ap.platform } : {}),
      margin: rec?.margin ?? 0, tooClose: rec?.tooClose ?? true, status: ap.status,
      complexity: { score: cx.score, band: cx.band },
      components: p ? (ap.variants[p]?.length ?? 0) : 0,
    };
  });
}

                                  
                         
                                    
                                           
                         
                                           
 

export function filterCatalogue(rows                         , f                 )                 {
  const q = (f.text ?? '').trim().toLowerCase();
  return rows.filter((r) =>
    (!q || `${r.name} ${r.owner} ${r.pattern}`.toLowerCase().includes(q))
    && (!f.platform || (r.chosen ?? r.recommended) === f.platform)
    && (!f.status || r.status === f.status)
    && (!f.kind || r.kind === f.kind)
    && (!f.origin || r.origin === f.origin));
}

/** Write one catalogue cell the grid lets the user edit (Owner, Kind, Pattern); the app is marked edited. */
export function setAppField(plan      , appId        , field                                                                                                                                                                                                                                , value        )       {
  const numeric = field === 'users' || field === 'concurrentUsers' || field === 'deadlineMonths';
  return {
    ...plan,
    apps: plan.apps.map((a) => {
      if (a.id !== appId) return a;
      const edited = [...new Set([...(a.edited ?? []), field])]                 ;
      const next                          = { ...a, edited };
      if (field === 'frameworks') next.frameworks = value.split(',').map((x) => x.trim()).filter(Boolean);
      else if (value === '') delete next[field];
      else next[field] = numeric ? Math.max(0, Number(value) || 0) : value;
      return next                  ;
    }),
  };
}

// ---------------------------------------------------------------------------
// Variants and components
// ---------------------------------------------------------------------------

/**
 * The components the app has on `p`, for display. When there is no variant
 * yet it is the one `ensureVariant` would create (translated or derived); the
 * plan is not changed until an edit calls `editVariant`.
 */
export function componentsOn(plan      , appId        , p          )                                                                                          {
  const e = ensureVariant(plan, appId, p);
  return { components: e.appPlan.variants[p] ?? [], created: e.created, findings: e.findings };
}

/** Change the app's variant on `p` (created first when missing). */
export function editVariant(plan      , appId        , p          , change                                                                         )       {
  const e = ensureVariant(plan, appId, p);
  const ap = e.appPlan;
  const list = change(ap.variants[p] ?? [], ap);
  return withAppPlan(e.plan, { ...ap, variants: { ...ap.variants, [p]: list } });
}

/** A component name not used in the variant yet: `base`, `base-2`, `base-3` … */
export function uniqueName(list                         , base        )         {
  const clean = slugName(base) || 'component';
  const taken = new Set(list.map((c) => slugName(c.name)));
  const ids = new Set(list.map((c) => c.id));
  if (!taken.has(clean)) return clean;
  for (let i = 2; ; i += 1) {
    const n = `${clean}-${i}`;
    if (!taken.has(n) && !ids.has(n)) return n;
  }
}

const DOMAIN_TIER                                                              = {
  database: 'data', integration: 'integration', lb: 'edge', dns: 'edge', compute: 'app', serverless: 'app', containers: 'platform', storage: 'data',
};

/** The tier a resource type starts in, from its equivalence row's domain. */
export function tierOfType(type        )                {
  const row = rowOf(type);
  return (row && DOMAIN_TIER[row.domain]) ?? 'other';
}

/** The provider-less name of a resource type: `aws_sqs_queue` → `sqs-queue`. */
export const bareType = (type        )         => slugName(type.replace(/^[a-z0-9]+_/, '').replace(/_/g, '-'));

/** The Terraform page's blueprint id for a resource type: `res_<type>` (clouds) or `vmw_<type>` (VMware providers). */
export function resourceBlueprintId(type        )         {
  return /^(aws|azurerm|azuread|google|oci)_/.test(type) ? `res_${type}` : `vmw_${type}`;
}

/** String values from a blueprint's defaults (the Terraform page's starting values). */
export function startingValues(bp                                       )                         {
  if (!bp) return {};
  const out                         = {};
  for (const [k, v] of Object.entries(defaultValues(bp             ))) {
    if (v === undefined || v === null || v === '') continue;
    out[k] = String(v);
  }
  return out;
}

/** "Add any service": one Terraform resource as a component of the app on `p`. */
export function addResourceComponent(plan      , appId        , p          , type        , options                                                                                                                = {})                                                {
  const app = findApp(plan, appId);
  if (!app) return { plan };
  let made                               ;
  const next = editVariant(plan, app.id, p, (list) => {
    const name = uniqueName(list, options.name ?? bareType(type));
    made = {
      id: componentId(app.name, name), name, tier: tierOfType(type), kind: 'resource', type,
      blueprintId: options.blueprintId ?? resourceBlueprintId(type), values: { ...(options.values ?? {}) }, status: 'ok',
    };
    return [...list, made];
  });
  return { plan: next, ...(made ? { component: made } : {}) };
}

/** "Add role" / "Add any module": one Ansible item as a component of the app on `p`. */
export function addConfigComponent(plan      , appId        , p          , blueprintId        , options                                                                                                                         = {})                                              {
  const app = findApp(plan, appId);
  if (!app) return { plan };
  let made                             ;
  const next = editVariant(plan, app.id, p, (list) => {
    const base = options.name ?? blueprintId.replace(/^mod_/, '').split('_').slice(-2).join('-');
    const name = uniqueName(list, base);
    const order = Math.max(0, ...list.filter((c)                       => c.kind === 'config').map((c) => c.order)) + 1;
    made = { id: componentId(app.name, name), name, tier: 'other', kind: 'config', blueprintId, values: { ...(options.values ?? {}) }, appliesTo: [...(options.appliesTo ?? [])], order, status: 'ok' };
    return [...list, made];
  });
  return { plan: next, ...(made ? { component: made } : {}) };
}

/** "Add from patterns": a new pattern component in a tier, with a tier pattern. */
export function addPatternComponent(plan      , appId        , p          , tier               , tierPattern                         , name         )                                               {
  const app = findApp(plan, appId);
  if (!app) return { plan };
  let made                              ;
  const next = editVariant(plan, app.id, p, (list) => {
    const n = uniqueName(list, name ?? tier);
    made = { id: componentId(app.name, n), name: n, tier, kind: 'pattern', ...(tierPattern ? { tierPattern } : {}), servers: [], databases: [], settings: {}, status: 'ok' };
    return [...list, made];
  });
  return { plan: next, ...(made ? { component: made } : {}) };
}

/** The tier patterns offered for a tier of the app on `p`, ranked (score, reasons, eliminated). */
export function rankForTier(plan      , appId        , tier               , p          )                      {
  const app = findApp(plan, appId);
  if (!app) return [];
  const pattern = app.pattern ?? 'generic';
  const ap = appPlanOrDraft(plan, app);
  const template = templateFor(pattern, tier) ?? templateFor('generic', tier) ?? {
    name: tier, tier, tierPattern: 'vm'               ,
    alternatives: ['paas-web', 'containers', 'serverless', 'managed-db', 'managed-cache', 'managed-messaging', 'object-storage', 'file-service']                 ,
  };
  return rankTierPatterns(pattern, template, p, ap.answers);
}

                                                                                                                                                                                                                                          

/** Change one component of the variant on `p`. */
export function updateComponent(plan      , appId        , p          , id        , patch       )       {
  return editVariant(plan, appId, p, (list) => list.map((c) => {
    if (c.id !== id) return c;
    const next                          = { ...c };
    if (patch.name !== undefined && patch.name.trim()) next.name = patch.name.trim();
    if (patch.tier !== undefined) next.tier = patch.tier;
    if (c.kind === 'config' && patch.appliesTo !== undefined) next.appliesTo = [...patch.appliesTo];
    if (c.kind === 'config' && patch.order !== undefined) next.order = patch.order;
    if ((c.kind === 'resource' || c.kind === 'config') && patch.values !== undefined) next.values = { ...patch.values };
    if (c.kind === 'pattern' && patch.settings !== undefined) next.settings = { ...patch.settings };
    return next                           ;
  }));
}

/** Remove a component from the variant on `p` (the other variants keep theirs). */
export function removeComponent(plan      , appId        , p          , id        )       {
  return editVariant(plan, appId, p, (list) => list.filter((c) => c.id !== id));
}

/** Components that refer to `id` in their values (`<type>.<name>.` addresses, or `appliesTo`). */
export function referencesTo(list                         , target              )           {
  const address = target.kind === 'resource' ? addressOf(target) : '';
  return list.filter((c) => c.id !== target.id && (
    (c.kind === 'config' && c.appliesTo.includes(target.id))
    || ((c.kind === 'resource' || c.kind === 'config') && address !== '' && Object.values(c.values).some((v) => v.includes(address)))
  )).map((c) => c.name);
}

/**
 * The findings of a resource or module component against its own blueprint:
 * no blueprint, or a schema that has not loaded, is an error naming it; a value
 * outside a closed dropdown is an error; a required argument left empty is a
 * warning (the Terraform page writes it as a variable to supply).
 */
export function componentFindings(c              , bp                                       , schemaFile         )            {
  if (c.kind === 'pattern') return [];
  const path = c.id;
  if (!bp) return [error('app.component.no-blueprint', `${c.name}: ${c.blueprintId} is not a blueprint the ${c.kind === 'resource' ? 'Terraform' : 'Ansible'} page has.`, { path })];
  if (bp.inputs.length === 0) {
    return [error('app.component.not-loaded', `${c.name}: the schema${schemaFile ? ` (${schemaFile})` : ''} has not loaded, so it cannot be checked or built.`, { path, remediation: 'Reload the page while online, or remove the component.' })];
  }
  const out            = [];
  for (const input of bp.inputs) {
    const v = (c.values[input.id] ?? '').trim();
    if (input.control === 'select' && v !== '' && (input.options ?? []).length > 0 && !(input.options ?? []).some((o) => o.value === v)) {
      out.push(error('app.component.value-not-offered', `${c.name}: ${input.label} is "${v}", which is not one of its choices.`, { path: `${path}.${input.id}` }));
    }
    const required = /(^|·\s*)required\b/.test(input.hint ?? '') || /\brequired\b/i.test(input.hint ?? '') && !/optional/i.test(input.hint ?? '');
    if (required && v === '' && String(input.default ?? '') === '') {
      out.push(warning('app.component.required-empty', `${c.name}: ${input.label} is required and empty; it is written as a variable to supply.`, { path: `${path}.${input.id}` }));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Sizing
// ---------------------------------------------------------------------------

                                
                         
                       
                              
                             
                           
                       
                        
                          
                                  
                                
                            
                         
                          
                               
                                           
                         
                                
                              
                             
 

const itemOf = (key        )         => key.split(':').slice(1).join(':') || key;

function demandText(d                                  )         {
  const units                                   = { vcpu: 'vCPU', ramGib: 'GiB RAM', gib: 'GiB', storageGib: 'GiB storage', iops: 'IOPS', mbps: 'MB/s', instances: 'instances', users: 'users' };
  return Object.entries(d).filter(([, v]) => Number.isFinite(v)).map(([k, v]) => `${Math.round(v * 10) / 10} ${units[k] ?? k}`).join(', ');
}

/** The grid rows of one sizing row. */
function gridRow(plan      , app     , p          , component              , concern        , row           )                {
  const override = String(row.detail['override'] ?? '');
  const engineChoice = String(row.detail['engineChoice'] ?? row.choice);
  let deltaVcpu                    ;
  let deltaRam                    ;
  if (row.key.startsWith('server:')) {
    const w = plan.workloads.find((x) => x.name === itemOf(row.key));
    const spec = p !== 'vmware' ? instanceSpec(p                , row.choice) : undefined;
    const vcpu = typeof row.detail['vcpu'] === 'number' ? row.detail['vcpu'] : spec?.vcpu ?? (p === 'vmware' ? row.demand['vcpu'] : undefined);
    const ram = typeof row.detail['ramGib'] === 'number' ? row.detail['ramGib'] : spec?.ramGib ?? (p === 'vmware' ? row.demand['ramGib'] : undefined);
    if (w && vcpu !== undefined) deltaVcpu = Math.round((vcpu - w.vcpu) * 10) / 10;
    if (w && ram !== undefined) deltaRam = Math.round((ram - w.ramGib) * 10) / 10;
    if (override && spec) {
      deltaVcpu = w ? spec.vcpu - w.vcpu : deltaVcpu;
      deltaRam = w ? spec.ramGib - w.ramGib : deltaRam;
    }
  }
  const coverage = row.detail['coveragePct'];
  return {
    appId: app.id, app: app.name, platform: p, component: component.name, concern, key: row.key, item: itemOf(row.key),
    demand: demandText(row.demand), recommendation: row.choice, engineChoice, override,
    fits: row.fits, reason: row.reasons.map((r) => r.text).join(' '), assumption: row.reasons.some((r) => r.assumption),
    alternatives: row.alternatives, basis: String(row.detail['basis'] ?? (row.reasons.some((r) => r.assumption) ? 'load (planning assumption)' : '')),
    ...(typeof coverage === 'number' ? { coveragePct: coverage } : {}),
    ...(deltaVcpu !== undefined ? { deltaVcpu } : {}),
    ...(deltaRam !== undefined ? { deltaRam } : {}),
  };
}

/** Every sizing row of an app on a platform: each component through every engine that applies. */
export function appSizingRows(plan      , appId        , p          )                                                 {
  const app = findApp(plan, appId);
  if (!app) return { rows: [], findings: [] };
  const e = ensureVariant(plan, app.id, p);
  const rows                  = [];
  const findings            = [];
  for (const c of e.appPlan.variants[p] ?? []) {
    for (const rec of sizeComponent(c, p, e.plan)) {
      findings.push(...rec.findings);
      for (const r of rec.rows) rows.push(gridRow(e.plan, app, p, c, rec.concern, r));
    }
  }
  return { rows, findings };
}

/** Every app's sizing on the platform it is shown on (the `#sizing` grid). */
export function estateSizingRows(plan      , recs                                             )                                                 {
  const rows                  = [];
  const findings            = [];
  for (const a of plan.apps) {
    const r = appSizingRows(plan, a.id, shownPlatform(plan, a.id, recs[a.id]));
    rows.push(...r.rows);
    findings.push(...r.findings);
  }
  return { rows, findings };
}

/** Set (or, with '', clear) one override. Overrides live in `Plan.sizing.overrides` and win over the engines. */
export function setOverride(plan      , key        , value        )       {
  const sizing = plan.sizing ?? defaultSizing();
  const overrides = { ...sizing.overrides };
  if (value.trim()) overrides[key] = value.trim();
  else delete overrides[key];
  return { ...plan, sizing: { ...sizing, overrides } };
}

/** "Accept all": clear the overrides of these rows. */
export function clearOverrides(plan      , keys                   )       {
  const sizing = plan.sizing ?? defaultSizing();
  const drop = new Set(keys);
  return { ...plan, sizing: { ...sizing, overrides: Object.fromEntries(Object.entries(sizing.overrides).filter(([k]) => !drop.has(k))) } };
}

export function policyOfPlan(plan      )               {
  return plan.sizing?.policy ?? DEFAULT_SIZING_POLICY;
}

/** Change the sizing policy. */
export function setPolicy(plan      , patch                       )       {
  const sizing = plan.sizing ?? defaultSizing();
  return { ...plan, sizing: { ...sizing, policy: { ...sizing.policy, ...patch } } };
}

/** Set (or clear, with NaN) one of the load engine's planning assumptions. */
export function setAssumption(plan      , key        , value        )       {
  const policy = policyOfPlan(plan);
  const assumptions = { ...policy.assumptions };
  if (Number.isFinite(value)) assumptions[key] = value;
  else delete assumptions[key];
  return setPolicy(plan, { assumptions });
}

const flat = (groups                                  )           => Object.values(groups).flatMap((v) => v.split(',')).filter(Boolean);
let catalogueCache                                             = {};

/** The family of a size name: `m7i` of `m7i.2xlarge`, `Standard_D` + `s_v5` of `Standard_D8s_v5`, `n2-standard` of `n2-standard-8`. */
export function sizeFamily(name        )         {
  if (/^Standard_/.test(name)) return name.replace(/(\d)-\d+/, '$1').replace(/\d+/, '#');
  if (name.includes('.')) return name.split('.').slice(0, name.startsWith('db.') ? 2 : 1).join('.');
  return name.replace(/-\d+$/, '');
}

/**
 * The values an override is offered: the engine's choice and alternatives,
 * then the rest of the chosen size's family from the platform's catalogue
 * (servers, and RDS classes on AWS). Any other value can still be typed.
 */
export function overrideChoices(p          , row                                                              )                 {
  const engine = [...new Set([row.engineChoice, ...row.alternatives].filter(Boolean))];
  const out                 = engine.map((v) => ({ value: v, label: v, group: 'Engine choice and alternatives' }));
  const listKey = row.key.startsWith('server:') ? `server:${p}` : row.key.startsWith('db:') && p === 'aws' ? 'db:aws' : '';
  if (listKey) {
    catalogueCache[listKey] ??= listKey === 'db:aws' ? flat(AWS_DB_INSTANCE_CLASS_GROUPS)
      : p === 'aws' ? flat(AWS_INSTANCE_TYPE_GROUPS) : p === 'azure' ? flat(AZURE_VM_SIZE_GROUPS) : p === 'google' ? flat(GCP_MACHINE_TYPE_GROUPS) : p === 'oci' ? flat(OCI_SHAPE_GROUPS) : [];
    const families = new Set(engine.map(sizeFamily));
    const same = (catalogueCache[listKey] ?? []).filter((v) => families.has(sizeFamily(v)) && !engine.includes(v)).slice(0, 60);
    for (const v of same) out.push({ value: v, label: v, group: 'Same family (catalogue)' });
  }
  return out;
}
/** For tests: forget the flattened catalogues. */
export function resetChoiceCache()       {
  catalogueCache = {};
}

// ---------------------------------------------------------------------------
// Readiness and the provider's vocabulary
// ---------------------------------------------------------------------------

const eolOn = (os        , on        )          => {
  try {
    return supportStatus(os                                       , on) === 'end-of-life';
  } catch {
    return false;
  }
};

                            
                         
                            
                       
                           
                                                                                      
 

/** Computed, never rated: 100 − 25 × blockers − 10 × EOL items − 10 × unknown-type items, floor 0. */
export function appReadiness(plan      , appId        , on        )            {
  const app = findApp(plan, appId);
  if (!app) return { score: 0, blockers: 0, eol: 0, unknown: 0, deductions: [] };
  const ws = appWorkloads(plan, app).filter((w) => !w.synthetic);
  const deductions                                      = [];
  let blockers = 0;
  let eol = 0;
  let unknown = 0;
  for (const w of ws) {
    for (const r of w.facts?.readiness ?? []) {
      if (r.severity !== 'blocker') continue;
      blockers += 1;
      deductions.push({ label: `${w.name}: ${r.id}`, points: 25 });
    }
    if (eolOn(w.os, on)) {
      eol += 1;
      deductions.push({ label: `${w.name}: ${w.os} is past end of support on ${on}`, points: 10 });
    }
    const type = w.workloadType ?? w.facts?.detection?.type ?? workloadTypeOf(w);
    if (!type || type === 'unknown') {
      unknown += 1;
      deductions.push({ label: `${w.name}: workload type unknown`, points: 10 });
    }
  }
  const score = Math.max(0, 100 - deductions.reduce((s, d) => s + d.points, 0));
  return { score, blockers, eol, unknown, deductions };
}

/**
 * Readiness said the provider's way (PROVIDER_TERMS.readiness): Azure's four
 * states, OCI's severities, and the other providers' own term with the score.
 */
export function providerReadiness(p          , r           )                                    {
  const term = PROVIDER_TERMS.readiness[p] ?? 'Readiness';
  if (p === 'azure') {
    const verdict = r.blockers > 0 ? 'Not ready' : r.unknown > 0 ? 'Readiness unknown' : r.eol > 0 ? 'Conditionally ready' : 'Ready';
    return { term: 'Azure Migrate readiness', verdict };
  }
  if (p === 'oci') return { term, verdict: r.blockers > 0 ? 'ERROR' : r.eol + r.unknown > 0 ? 'WARNING' : 'INFO' };
  const flags = [r.blockers ? `${r.blockers} blocker(s)` : '', r.eol ? `${r.eol} past end of support` : '', r.unknown ? `${r.unknown} of unknown type` : ''].filter(Boolean);
  return { term, verdict: `${r.score} / 100${flags.length > 0 ? `; ${flags.join(', ')}` : ''}` };
}

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

                                                                                                                                                                     

/** The app's edges in and out (by app name or its servers' and databases' names). */
export function appEdgeRows(plan      , appId        )               {
  const app = findApp(plan, appId);
  if (!app) return [];
  const mine = new Set([app.name, ...appWorkloads(plan, app).map((w) => w.name), ...appDatabases(plan, app).map((d) => d.name)]);
  const out               = [];
  plan.edges.forEach((e, index) => {
    if (mine.has(e.from)) out.push({ index, from: e.from, to: e.to, kind: e.kind, direction: 'out' });
    else if (mine.has(e.to)) out.push({ index, from: e.from, to: e.to, kind: e.kind, direction: 'in' });
  });
  return out;
}

export function setEdgeKind(plan      , index        , kind                  )       {
  return { ...plan, edges: plan.edges.map((e, i) => (i === index ? { ...e, kind } : e)) };
}

// ---------------------------------------------------------------------------
// Answers, ingress, route
// ---------------------------------------------------------------------------

export function editAppPlan(plan      , appId        , change                          )       {
  const app = findApp(plan, appId);
  if (!app) return plan;
  return withAppPlan(plan, change(appPlanOrDraft(plan, app)));
}

export function setAnswer(plan      , appId        , key        , value        )       {
  return editAppPlan(plan, appId, (ap) => {
    const answers = { ...ap.answers };
    if (value === '') delete answers[key];
    else answers[key] = value;
    return { ...ap, answers };
  });
}

/** A short text for an app's findings count by severity. */
export function severityCounts(findings                    )                                                   {
  return {
    error: findings.filter((f) => f.severity === 'error').length,
    warning: findings.filter((f) => f.severity === 'warning').length,
    info: findings.filter((f) => f.severity === 'info').length,
  };
}

export const noteFinding = (text        )          => info('app.note', text);
