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

import { info, warning, type Finding } from '../../../core/findings.ts';
import { inCatalog, instanceSpec, type SpecPlatform } from '../../../kit/instance-specs.ts';
import type { AppComponent, Plan, Platform, SizingConcern, SizingRecommendation, SizingRow } from '../types.ts';
import { databaseEngine } from './database.ts';
import { fileEngine } from './file.ts';
import { k8sEngine } from './k8s.ts';
import { loadEngine } from './load.ts';
import { sapEngine } from './sap.ts';
import { policyOf, serverEngine, type SizingPolicyExt } from './server.ts';
import { storageEngine } from './storage.ts';
import { vcfEngine } from './vcf.ts';
import { vdiEngine } from './vdi.ts';

export interface SizingEngine<I = unknown> {
  readonly id: SizingConcern;
  /** The platforms it sizes for; undefined = all. */
  readonly platforms?: readonly Platform[];
  applies(c: AppComponent, plan: Plan): boolean;
  /** Gathered from the rows, perf data, pattern answers and load profile. */
  inputs(c: AppComponent, plan: Plan): I;
  size(input: I, platform: Platform, policy: SizingPolicyExt): SizingRecommendation;
}

/** The default registry, in the order the Sizing tab shows the sections. */
export const SIZING_ENGINES: readonly SizingEngine[] = Object.freeze([
  serverEngine, storageEngine, k8sEngine, databaseEngine, sapEngine, vdiEngine, fileEngine, vcfEngine, loadEngine,
] as SizingEngine[]);

/** A copy of `list` with `engine` added (at the end) or replacing the engine with its id. */
export function withEngine(engine: SizingEngine, list: readonly SizingEngine[] = SIZING_ENGINES): SizingEngine[] {
  const at = list.findIndex((e) => e.id === engine.id);
  return at >= 0 ? list.map((e, i) => (i === at ? engine : e)) : [...list, engine];
}

// ---------------------------------------------------------------------------
// Overrides
// ---------------------------------------------------------------------------

/** Apply `overrides` (row key → value) to a recommendation: the override wins; one that fails the demand is kept with a warning. */
export function applyOverrides(r: SizingRecommendation, overrides: Readonly<Record<string, string>>): SizingRecommendation {
  const findings: Finding[] = [...r.findings];
  const rows = r.rows.map((row): SizingRow => {
    const value = overrides[row.key]?.trim();
    if (!value || value === row.choice) return row;
    let fits = true;
    let why = '';
    if (row.key.startsWith('server:') && r.platform !== 'vmware') {
      const p = r.platform as SpecPlatform;
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
export function sizeComponent(c: AppComponent, platform: Platform, plan: Plan, engines: readonly SizingEngine[] = SIZING_ENGINES): SizingRecommendation[] {
  const policy = policyOf(plan);
  const overrides = plan.sizing?.overrides ?? {};
  const out: SizingRecommendation[] = [];
  for (const e of engines) {
    if (e.platforms && !e.platforms.includes(platform)) continue;
    if (!e.applies(c, plan)) continue;
    out.push(applyOverrides(e.size(e.inputs(c, plan), platform, policy), overrides));
  }
  return out;
}

/** Size every component of an app's variant on a platform. */
export function sizeApp(plan: Plan, appId: string, platform: Platform, engines: readonly SizingEngine[] = SIZING_ENGINES): SizingRecommendation[] {
  const ap = (plan.appPlans ?? []).find((x) => x.app === appId);
  const comps = ap?.variants[platform] ?? [];
  const out: SizingRecommendation[] = [];
  for (const c of comps) out.push(...sizeComponent(c, platform, plan, engines));
  if (comps.length === 0) {
    return [{ concern: 'server', platform, rows: [], findings: [info('size.no-components', `${appId} has no components on ${platform} to size.`)] }];
  }
  return out;
}

/** The rows of several recommendations, flattened (the `#sizing` grid). */
export const rowsOf = (list: readonly SizingRecommendation[]): SizingRow[] => list.flatMap((r) => r.rows);

export {
  DEFAULT_SIZING_POLICY, chooseInstance, confidenceStars, policyOf, serverDemand, sizeServer, CONFIDENCE_WARN, MIN_COVERAGE, MIN_DAYS,
  type ChooseOptions, type Choice, type HeadroomStyle, type InstanceFit, type ResourceStrategy, type ServerDemand, type SizingMethodology,
  type SizingMode, type SizingPolicyExt,
} from './server.ts';
export { databaseEngine, fileEngine, k8sEngine, loadEngine, sapEngine, serverEngine, storageEngine, vcfEngine, vdiEngine };
