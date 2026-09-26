/**
 * Compare (addendum A.2.3, A.2.7): an application side by side on every
 * allowed platform, VMware Cloud Foundation included when it is allowed.
 *
 * For each platform the app slice is built with that platform chosen (the
 * variant it has there, or the current one translated — previewed, never
 * stored), then `decidePlan` and `designPlan` run on the slice, and the
 * column is read from the result:
 *
 *   verdict        eligible (or eligible with gaps: a component with no
 *                  equivalent), score and delta to the recommendation;
 *   why            the top rule hits, with reason, verification and source;
 *   components     per component: tier pattern, service and size / class,
 *                  and the translation (mapped / partial / no-equivalent);
 *   licences       the LicenceNeed totals and model;
 *   footprint      the sized vCPU, RAM, storage by type, DB instances, pools;
 *   estimate       only with a user rate card, always labelled; else absent;
 *   stand up first landing zone, connectivity, identity, pattern prerequisites;
 *   migration path the items' methods and downtime class;
 *   findings       counts by severity, and the list;
 *   eliminated     for an ineligible platform, the eliminating rules per item.
 *
 * About five (decide + design) runs over a few dozen items: well under 50 ms.
 */

                                                         
import { DB_SERVICES } from '../db-catalog.js';
                                                        
import { designPlan } from '../design/index.js';
import { osKind } from '../os.js';
import { PLATFORM_LABELS, PLATFORM_VALUES } from '../options.js';
import { isNone, tierTarget, withPatternMappers } from '../patterns/index.js';
import { sizeComponent } from '../sizing/index.js';
             
                                                                                                                                                  
                     
import { estimateDesign,                    } from '../estate/estimate.js';
import { appPlanOf, defaultAppPlan, deriveComponents, findApp, regionsOf, withAppPlan, withoutServiceSynthetics } from './components.js';
import { decideApps, eliminatorsOn, recommendApp, recommendationDecision, appItemDecisions } from './recommend.js';
import { appSlice } from './slice.js';
import { translateVariant,                                                                   } from './translate.js';

                                                         

                                
                               
                        
                                      
                                     
                                                            
                           
                                                                                            
                                    
                                       
                                          
                           
                                                 
                                  
                           
 

                                
                              
                         
                     
                               
                                                                                      
                               
                           
                                                    
                           
                                  
                             
    
                                   
                                                
                                                                                                                     
                       
                          
                            
                                                                                 
                                 
                               
                                                
    
                                                                                            
                                                                                                                                                                  
                                                                                        
                                                                                                                                  
                                                                                                                                    
                                                                                                                                                  
 

                                
                       
                                             
                                             
 

                                 
                                                                      
                                             
                                  
                                                                
                                           
 

const DOWNTIME                                                  = {
  'relocate-hcx': 'none', replicate: 'minutes', 'managed-db': 'minutes', rebuild: 'hours', none: 'n/a',
};

/** The app plan's components on `p`: its variant there, or the current one translated (a preview). */
function componentsOn(plan      , ap         , p          )                                                                                                              {
  const own = ap.variants[p];
  if (own) return { components: own, translations: [], findings: [] };
  const from = (ap.platform && ap.variants[ap.platform]) ? ap.platform : PLATFORM_VALUES.find((x) => ap.variants[x]);
  if (!from) return { components: deriveComponents(plan, ap.app), translations: [], findings: [] };
  const t = translateVariant(ap.variants[from] ?? [], from, p, { regions: regionsOf(plan) });
  return { components: t.components, translations: t.translations, findings: t.findings };
}

function tierPatternShown(c              , decision              , plan      )                          {
  if (c.kind !== 'pattern') return undefined;
  if (c.tierPattern) return c.tierPattern;
  const dbs = plan.databases.filter((d) => c.databases.includes(d.name));
  if (dbs.some((d) => decision.items[d.id]?.chosen?.service && DB_SERVICES[decision.items[d.id] .chosen .service ].managed)) return 'managed-db';
  return 'vm';
}

function sizesOf(c              , p          , plan      , decision              , design              )           {
  if (c.kind === 'resource') return [c.type];
  if (c.kind === 'config') return [c.blueprintId];
  const pd = design.platforms.find((x) => x.platform === p);
  const out           = [];
  const byName = new Map(plan.workloads.map((w) => [w.name, w]));
  const bySize = new Map                ();
  for (const n of c.servers) {
    const w = byName.get(n);
    const t = w ? pd?.compute.find((x) => x.workload === w.id) : undefined;
    if (t) bySize.set(t.size, (bySize.get(t.size) ?? 0) + 1);
  }
  for (const [size, n] of bySize) out.push(n > 1 ? `${size} ×${n}` : size);
  const byClass = new Map                ();
  for (const dn of c.databases) {
    const d = plan.databases.find((x) => x.name === dn);
    const t = d ? pd?.databases.find((x) => x.database === d.id) : undefined;
    if (!t) continue;
    const text = [DB_SERVICES[t.service]?.label ?? t.service, t.classOrShape, t.ha && t.ha !== 'none' ? t.ha : ''].filter(Boolean).join(' ');
    byClass.set(text, (byClass.get(text) ?? 0) + 1);
  }
  for (const [text, n] of byClass) out.push(n > 1 ? `${text} ×${n}` : text);
  // Components that are not VMs (new apps): the load engine's sizing.
  if (out.length === 0 && c.tierPattern && c.tierPattern !== 'vm') {
    for (const r of sizeComponent(c, p, plan).flatMap((x) => x.rows)) out.push(r.choice);
  }
  void decision;
  return out;
}

function standUpFirst(plan      , p          , design              , decision              , components                         )                                      {
  const lzDesigned = !!plan.execution?.landingZones?.[p];
  const out                                      = [];
  if (p !== 'vmware') out.push({ what: `The ${PLATFORM_LABELS[p]} landing zone${lzDesigned ? ' (designed on Migration & Utilities)' : ''}`, exists: lzDesigned });
  const sites = new Set(plan.workloads.flatMap((w) => w.dependsOn.filter((d) => d.startsWith('site:')).map((d) => d.slice(5))));
  for (const s of sites) out.push({ what: `Connectivity to ${s}`, exists: lzDesigned && plan.requirements.sites.some((x) => x.name === s) });
  if (plan.workloads.some((w) => osKind(w.os) === 'windows') && plan.requirements.identity.adStrategy !== 'none') {
    out.push({ what: plan.requirements.identity.adStrategy === 'managed-ad' ? 'Identity: the managed directory' : 'Identity: domain controllers in the landing zone', exists: lzDesigned });
  }
  const pd = design.platforms.find((x) => x.platform === p);
  const services = new Set(pd?.databases.map((d) => d.service) ?? []);
  if (services.has('azure-sqlmi')) out.push({ what: 'A delegated subnet for SQL Managed Instance', exists: false });
  for (const s of services) if (/-odb-/.test(s)) out.push({ what: `Oracle Database@${PLATFORM_LABELS[p]} offered in the region (check the region list)`, exists: false });
  const tps = new Set(components.flatMap((c) => (c.kind === 'pattern' && c.tierPattern ? [c.tierPattern] : [])));
  if (tps.has('containers')) out.push({ what: `A Kubernetes cluster (${({ aws: 'EKS', azure: 'AKS', google: 'GKE', oci: 'OKE', vmware: 'vSphere Kubernetes Service' }         )[p]})`, exists: false });
  if (tps.has('vdi-service') && p === 'azure') out.push({ what: 'An Azure Virtual Desktop workspace and host pool', exists: false });
  if (Object.values(decision.items).some((d) => d.method === 'relocate-hcx' && d.chosen?.platform === p)) out.push({ what: 'HCX activated between the source and the target VMware environment', exists: false });
  return out;
}

/**
 * The comparison of one app on every allowed platform. Pure: the plan is not
 * changed and no variant is created.
 */
export function compareApp(plan      , appId        , options                 = {})                {
  const app = findApp(plan, appId);
  if (!app) return { app: appId, recommendation: { app: appId, perPlatform: [], margin: 0, tooClose: true }, columns: [] };
  const ap = appPlanOf(plan, app.id) ?? defaultAppPlan(app);
  const base = appSlice(withAppPlan(plan, ap), [app.id]);
  const free = recommendationDecision(base, options.engine);
  const recommendation = recommendApp(base, free, app.id);
  const recScore = recommendation.recommended ? recommendation.perPlatform.find((x) => x.platform === recommendation.recommended)?.score ?? 0 : 0;
  const freeItems = appItemDecisions(base, free, app.id);
  const platforms = PLATFORM_VALUES.filter((p) => plan.requirements.allowed.includes(p) && (!options.platforms || options.platforms.includes(p)));
  const columns                  = [];
  for (const p of platforms) {
    const on = componentsOn(base, ap, p);
    const slice = withAppPlan(base, { ...ap, platform: p, variants: { ...ap.variants, [p]: on.components } });
    const decision = decideApps(slice, options.engine);
    const design = withoutServiceSynthetics(slice, designPlan(slice, decision, withPatternMappers()));
    const rec = recommendation.perPlatform.find((x) => x.platform === p);
    const translationOf = new Map(on.translations.map((t) => [t.componentId, t]));
    const components                  = on.components.map((c) => {
      const t = translationOf.get(c.id);
      const tp = tierPatternShown(c, decision, slice);
      const target = tp ? tierTarget(tp, p) : undefined;
      // A data component names the database services it was placed on, where it has any.
      const pdHere = design.platforms.find((x) => x.platform === p);
      const dbServices = c.kind === 'pattern'
        ? [...new Set(c.databases.map((n) => slice.databases.find((d) => d.name === n)).flatMap((d) => (d ? pdHere?.databases.filter((t) => t.database === d.id) ?? [] : [])).map((t) => DB_SERVICES[t.service]?.label ?? t.service))]
        : [];
      const service = c.kind === 'resource' ? c.type : c.kind === 'config' ? c.blueprintId
        : dbServices.length > 0 && (tp === 'managed-db' || tp === 'managed-cache') ? dbServices.join(', ')
          : target ? (isNone(target) ? `none: ${target.none}` : target.service) : '';
      const outcome                     = t?.outcome ?? (c.status === 'unresolved' ? 'no-equivalent' : c.status === 'partial' ? 'partial' : 'mapped');
      return {
        componentId: c.id, name: c.name, kind: c.kind, ...(tp ? { tierPattern: tp } : {}), service,
        sizes: sizesOf(c, p, slice, decision, design),
        outcome, targetTypes: t?.targetTypes ?? (c.kind === 'resource' ? [c.type] : []),
        carried: t?.carried.length ?? c.translatedFrom?.carried ?? 0,
        dropped: t?.dropped ?? c.translatedFrom?.dropped ?? [],
        ...(t?.proposal ? { proposal: t.proposal } : {}),
        ...(t?.reason ? { reason: t.reason } : {}),
      };
    });
    // Licences.
    const lic = new Map                                                                   ();
    for (const d of appItemDecisions(slice, decision, app.id)) {
      const l = d.chosen?.licence;
      if (!l || l.kind === 'none' || l.count === 0) continue;
      const k = `${l.kind}|${l.model}`;
      const cur = lic.get(k) ?? { kind: l.kind, model: l.model, count: 0 };
      lic.set(k, { ...cur, count: cur.count + l.count });
    }
    // Footprint.
    const pd = design.platforms.find((x) => x.platform === p);
    const storage = new Map                ();
    for (const c of pd?.compute ?? []) for (const d of c.disks) storage.set(d.type, (storage.get(d.type) ?? 0) + d.gib);
    const managed = [...new Set((pd?.databases ?? []).filter((d) => DB_SERVICES[d.service]?.managed).map((d) => DB_SERVICES[d.service] .label))];
    for (const c of components) if (c.tierPattern && !['vm', 'managed-db', 'retire', 'retain'].includes(c.tierPattern) && !c.service.startsWith('none')) managed.push(c.service);
    const pools = components.filter((c) => c.tierPattern === 'containers').length;
    // Estimate.
    const est = options.rateCard && options.rateCard.rows.length > 0 ? estimateDesign(slice, decision, design, options.rateCard) : undefined;
    // Findings.
    const list            = [...on.findings, ...decision.findings, ...design.findings];
    // Eliminated because.
    const eliminatedBecause = rec && !rec.eligible
      ? freeItems.filter((d) => !d.options.some((o) => o.platform === p && !o.eliminated)).map((d) => {
        const name = base.workloads.find((w) => w.id === d.id)?.name ?? base.databases.find((x) => x.id === d.id)?.name ?? d.id;
        const rules = eliminatorsOn(d, p).map((rule) => {
          const hit = d.options.filter((o) => o.platform === p).flatMap((o) => o.hits).find((h) => h.rule === rule);
          return { rule, reason: hit?.reason ?? (rule === 'no-option' ? `No service on ${PLATFORM_LABELS[p]} runs it.` : rule) };
        });
        return { item: name, rules };
      })
      : [];
    columns.push({
      platform: p,
      label: PLATFORM_LABELS[p],
      verdict: {
        eligible: rec?.eligible ?? false,
        withGaps: components.some((c) => c.outcome === 'no-equivalent'),
        score: rec?.score ?? 0,
        delta: (rec?.score ?? 0) - recScore,
        recommended: recommendation.recommended === p,
        chosen: ap.platform === p,
      },
      why: rec?.topHits ?? [],
      components,
      licences: [...lic.values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.model.localeCompare(b.model)),
      footprint: {
        vcpu: (pd?.compute ?? []).reduce((s, c) => s + c.vcpu, 0),
        ramGib: (pd?.compute ?? []).reduce((s, c) => s + c.ramGib, 0),
        storage: [...storage.entries()].map(([type, gib]) => ({ type, gib })).sort((a, b) => a.type.localeCompare(b.type)),
        dbInstances: pd?.databases.length ?? 0,
        nodePools: pools,
        managedServices: [...new Set(managed)].sort(),
      },
      ...(est?.available ? { estimate: { label: est.label, monthly: est.monthly[p] ?? [], oneTime: est.oneTime[p] ?? [], noRate: est.noRate.length } } : {}),
      standUpFirst: standUpFirst(slice, p, design, decision, on.components),
      migrationPath: appItemDecisions(slice, decision, app.id).map((d) => ({
        item: slice.workloads.find((w) => w.id === d.id)?.name ?? slice.databases.find((x) => x.id === d.id)?.name ?? d.id,
        method: d.disposition === 'new' ? 'deploy' : d.method,
        downtime: d.disposition === 'new' ? 'n/a' : DOWNTIME[d.method] ?? 'n/a',
      })),
      findings: {
        error: list.filter((f) => f.severity === 'error').length,
        warning: list.filter((f) => f.severity === 'warning').length,
        info: list.filter((f) => f.severity === 'info').length,
        list,
      },
      eliminatedBecause,
    });
  }
  return { app: app.id, recommendation, columns };
}
