/**
 * Sizing (addendum A.2.8): one pluggable engine per concern, in a registry.
 *
 * A component is sized on a platform by every engine that applies to it (and
 * is offered on that platform). Engines are pure and use only committed data.
 * Every recommendation carries its reasons and up to three alternatives, and
 * the plan's overrides (`Plan.sizing.overrides`, row key → value) win over the
 * engines; an override that fails the demand is kept, with a warning.
 *
 * `SIZING_ENGINES` is the default registry; `withEngine` returns a copy with an
 * engine added or replaced, and every entry point takes the list to use.
 */

import { info, warning,              } from '../../../core/findings.js';
import { inCatalog, instanceSpec,                   } from '../../../kit/instance-specs.js';
                                                                                                                
import { databaseEngine } from './database.js';
import { fileEngine } from './file.js';
import { k8sEngine } from './k8s.js';
import { loadEngine } from './load.js';
import { sapEngine } from './sap.js';
import { policyOf, serverEngine,                      } from './server.js';
import { storageEngine } from './storage.js';
import { vcfEngine } from './vcf.js';
import { vdiEngine } from './vdi.js';

                                            
                             
                                                     
                                           
                                                
                                                                             
                                         
                                                                                    
 

/** The default registry, in the order the Sizing tab shows the sections. */
export const SIZING_ENGINES                          = Object.freeze([
  serverEngine, storageEngine, k8sEngine, databaseEngine, sapEngine, vdiEngine, fileEngine, vcfEngine, loadEngine,
]                  );

/** A copy of `list` with `engine` added (at the end) or replacing the engine with its id. */
export function withEngine(engine              , list                          = SIZING_ENGINES)                 {
  const at = list.findIndex((e) => e.id === engine.id);
  return at >= 0 ? list.map((e, i) => (i === at ? engine : e)) : [...list, engine];
}

// ---------------------------------------------------------------------------
// Overrides
// ---------------------------------------------------------------------------

/** Apply `overrides` (row key → value) to a recommendation: the override wins; one that fails the demand is kept with a warning. */
export function applyOverrides(r                      , overrides                                  )                       {
  const findings            = [...r.findings];
  const rows = r.rows.map((row)            => {
    const value = overrides[row.key]?.trim();
    if (!value || value === row.choice) return row;
    let fits = true;
    let why = '';
    if (row.key.startsWith('server:') && r.platform !== 'vmware') {
      const p = r.platform                ;
      const spec = instanceSpec(p, value);
      if (!inCatalog(p, value)) { fits = false; why = `${value} is not in the ${r.platform} catalogue`; }
      else if (spec && (spec.vcpu < (row.demand['vcpu'] ?? 0) || spec.ramGib < (row.demand['ramGib'] ?? 0))) {
        fits = false;
        why = `${value} (${spec.vcpu} / ${spec.ramGib}) is below the demand of ${row.demand['vcpu']} vCPU / ${row.demand['ramGib']} GiB`;
      }
    }
    if (!fits) findings.push(warning('size.override-below-demand', `${row.key}: the override ${why}; it is kept as chosen.`, { path: `sizing.overrides.${row.key}` }));
    return {
      ...row,
      choice: value,
      fits,
      detail: { ...row.detail, override: value, engineChoice: row.choice },
      reasons: [...row.reasons, { text: `Overridden: ${value} (the engine chose ${row.choice || 'nothing'}).` }],
      alternatives: row.choice ? [row.choice, ...row.alternatives.filter((a) => a !== value)].slice(0, 3) : row.alternatives,
    };
  });
  return { ...r, rows, findings };
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/**
 * Size one component on one platform: one recommendation per engine that
 * applies (A.2.8.1 names a single return; a component can have several
 * concerns — servers, their volumes, a database — so this returns them all).
 */
export function sizeComponent(c              , platform          , plan      , engines                          = SIZING_ENGINES)                         {
  const policy = policyOf(plan);
  const overrides = plan.sizing?.overrides ?? {};
  const out                         = [];
  for (const e of engines) {
    if (e.platforms && !e.platforms.includes(platform)) continue;
    if (!e.applies(c, plan)) continue;
    out.push(applyOverrides(e.size(e.inputs(c, plan), platform, policy), overrides));
  }
  return out;
}

/** Size every component of an app's variant on a platform. */
export function sizeApp(plan      , appId        , platform          , engines                          = SIZING_ENGINES)                         {
  const ap = (plan.appPlans ?? []).find((x) => x.app === appId);
  const comps = ap?.variants[platform] ?? [];
  const out                         = [];
  for (const c of comps) out.push(...sizeComponent(c, platform, plan, engines));
  if (comps.length === 0) {
    return [{ concern: 'server', platform, rows: [], findings: [info('size.no-components', `${appId} has no components on ${platform} to size.`)] }];
  }
  return out;
}

/** The rows of several recommendations, flattened (the `#sizing` grid). */
export const rowsOf = (list                                 )              => list.flatMap((r) => r.rows);

export {
  DEFAULT_SIZING_POLICY, chooseInstance, confidenceStars, policyOf, serverDemand, sizeServer, CONFIDENCE_WARN, MIN_COVERAGE, MIN_DAYS,
                                                                                                                                          
                                        
} from './server.js';
export { databaseEngine, fileEngine, k8sEngine, loadEngine, sapEngine, serverEngine, storageEngine, vcfEngine, vdiEngine };
