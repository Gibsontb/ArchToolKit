/**
 * New application (greenfield, addendum A.2.10): a service with no servers
 * and no source. It starts from a greenfield pattern (or blank) with its
 * tier-pattern template, an owner, a criticality and a load profile; the load
 * engine sizes its components into synthetic items, so the engine recommends
 * a cloud for it from the requirements exactly as for a migrating app.
 *
 * The load profile is also edited here for an existing new app (its
 * workspace's Overview); every change regenerates the synthetic items.
 */

import { el, append } from '../dom.ts';
import { renderBlueprintForm } from '../blueprint-form.ts';
import type { BlueprintInput, BlueprintValues } from '../../kit/blueprint.ts';
import { DEFAULT_LOAD, newApplication, setLoadProfile } from '../../multicloud/plan/apps/components.ts';
import {
  APP_PATTERN_OPTIONS, COST_CLASS_OPTIONS, CRITICALITY_OPTIONS, ENV_OPTIONS, HORIZON_YEARS_OPTIONS, NONPROD_PCT_OPTIONS, SLO_OPTIONS, itemId,
} from '../../multicloud/plan/options.ts';
import { PATTERN_LIST } from '../../multicloud/plan/patterns/index.ts';
import type { AppPattern, CostClass, Criticality, Env, HorizonYears, LoadProfile, NonprodPct, Plan, Slo } from '../../multicloud/plan/types.ts';
import { button, note } from './kit.ts';

/** The greenfield patterns, as the New application dropdown offers them. */
export const GREENFIELD_OPTIONS = APP_PATTERN_OPTIONS.filter((o) => PATTERN_LIST.some((e) => e.id === o.value && e.family === 'greenfield'))
  .map((o) => ({ value: o.value, label: o.label }));

/** What each greenfield pattern stands up (its components), for the dropdown's hint. */
export function patternComponents(pattern: AppPattern): string {
  const e = PATTERN_LIST.find((x) => x.id === pattern);
  if (!e || e.components.length === 0) return 'No components: add them yourself.';
  return e.components.map((c) => `${c.name} (${c.tierPattern})`).join(', ');
}

/** The load profile as blueprint inputs (so it renders with the form's dropdowns and grids). */
export const LOAD_INPUTS: readonly BlueprintInput[] = [
  { id: 'users', label: 'Named users', control: 'number', min: 0 },
  { id: 'concurrentUsers', label: 'Peak concurrent users', control: 'number', min: 0 },
  { id: 'peakRps', label: 'Peak requests per second', control: 'number', min: 0 },
  { id: 'payloadKb', label: 'Average payload', control: 'number', min: 0, hint: 'KB' },
  { id: 'costClass', label: 'Request cost', control: 'select', options: COST_CLASS_OPTIONS, blankLabel: '(typical)' },
  { id: 'dataGib', label: 'Data', control: 'number', min: 0, hint: 'GiB' },
  { id: 'growthPctYear', label: 'Growth', control: 'number', min: 0, max: 500, hint: '% a year' },
  { id: 'horizonYears', label: 'Horizon', control: 'select', options: HORIZON_YEARS_OPTIONS, blankLabel: '(3 years)' },
  { id: 'tps', label: 'Transactions per second', control: 'number', min: 0 },
  { id: 'slo', label: 'Availability SLO', control: 'select', options: SLO_OPTIONS, blankLabel: '(99.9%)' },
  { id: 'p95Ms', label: 'p95 latency target', control: 'number', min: 0, hint: 'ms' },
  { id: 'environments', label: 'Environments', control: 'checklist', options: ENV_OPTIONS.filter((o) => o.value !== 'dr') },
  { id: 'nonprodPct', label: 'Non-production size', control: 'select', options: NONPROD_PCT_OPTIONS },
];

const NUMERIC = ['users', 'concurrentUsers', 'peakRps', 'payloadKb', 'dataGib', 'growthPctYear', 'tps', 'p95Ms'] as const;

export function loadValues(load: LoadProfile = DEFAULT_LOAD): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of NUMERIC) if (load[k] !== undefined) out[k] = String(load[k]);
  if (load.costClass) out.costClass = load.costClass;
  if (load.horizonYears) out.horizonYears = String(load.horizonYears);
  if (load.slo) out.slo = load.slo;
  out.environments = load.environments.join(', ');
  out.nonprodPct = String(load.nonprodPct);
  return out;
}

export function loadFromValues(values: BlueprintValues): LoadProfile {
  const num = (k: string): number | undefined => {
    const v = String(values[k] ?? '').trim();
    if (v === '') return undefined;
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : undefined;
  };
  const envs = String(values['environments'] ?? '').split(',').map((s) => s.trim()).filter(Boolean) as Env[];
  const out: Record<string, unknown> = { environments: envs.length > 0 ? envs : ['prod'], nonprodPct: Number(values['nonprodPct'] ?? 25) as NonprodPct };
  for (const k of NUMERIC) {
    const n = num(k);
    if (n !== undefined) out[k] = n;
  }
  const cost = String(values['costClass'] ?? '');
  if (cost) out.costClass = cost as CostClass;
  const horizon = String(values['horizonYears'] ?? '');
  if (horizon) out.horizonYears = Number(horizon) as HorizonYears;
  const slo = String(values['slo'] ?? '');
  if (slo) out.slo = slo as Slo;
  return out as unknown as LoadProfile;
}

/** The load profile form for an existing new app: every change regenerates its synthetic items. */
export function loadProfileForm(load: LoadProfile | undefined, onChange: (load: LoadProfile) => void): HTMLElement {
  let values: Record<string, string> = loadValues(load ?? DEFAULT_LOAD);
  const wrap = el('div', { class: 'two', attrs: { 'data-control': 'load-profile' } });
  append(wrap, ...renderBlueprintForm({ inputs: LOAD_INPUTS }, {
    values: () => values,
    set: (id, v) => {
      values = { ...values, [id]: v };
      onChange(loadFromValues(values));
    },
  }));
  return wrap;
}

export const NEW_APP_INPUTS: readonly BlueprintInput[] = [
  { id: 'name', label: 'Name', control: 'text', placeholder: 'e.g. customer-portal' },
  { id: 'pattern', label: 'Start from', control: 'select', options: GREENFIELD_OPTIONS },
  { id: 'owner', label: 'Owner', control: 'text', placeholder: 'team or person' },
  { id: 'criticality', label: 'Criticality', control: 'select', options: CRITICALITY_OPTIONS },
];

/** Create the app from the form's values; `error` names what is wrong. */
export function createFromValues(plan: Plan, values: Readonly<Record<string, string>>, load: LoadProfile): { plan: Plan; appId: string } | { error: string } {
  const name = (values.name ?? '').trim();
  if (!name) return { error: 'Give the application a name.' };
  if (plan.apps.some((a) => a.id === itemId('app', name))) return { error: `There is already an application called ${name}.` };
  const made = newApplication(plan, {
    name,
    pattern: (values.pattern || 'web-app') as AppPattern,
    ...(values.owner?.trim() ? { owner: values.owner.trim() } : {}),
    criticality: (values.criticality || 'tier2') as Criticality,
    load,
  });
  return { plan: made.plan, appId: made.app.id };
}

/** The New application card. `create` is handed the new plan and the app id. */
export function newAppCard(plan: () => Plan, create: (next: Plan, appId: string) => void, onCancel?: () => void): HTMLElement {
  let values: Record<string, string> = { pattern: 'web-app', criticality: 'tier2' };
  let load: LoadProfile = { ...DEFAULT_LOAD, environments: ['dev', 'prod'] };
  const hint = note(patternComponents('web-app'), 'new-app-template');
  const message = el('p', { class: 'small', attrs: { role: 'status', 'data-control': 'new-app-message' } });
  const fields = el('div', { class: 'two' });
  append(fields, ...renderBlueprintForm({ inputs: NEW_APP_INPUTS }, {
    values: () => values,
    set: (id, v) => {
      values = { ...values, [id]: v };
      if (id === 'pattern') hint.textContent = patternComponents(v as AppPattern);
    },
  }));
  const go = button('Create the application', () => {
    const r = createFromValues(plan(), values, load);
    if ('error' in r) {
      message.textContent = r.error;
      return;
    }
    create(r.plan, r.appId);
  }, { primary: true, control: 'new-app-create' });
  return el('section', { class: 'card', attrs: { 'data-control': 'new-app' } },
    el('div', { class: 'card-title' }, el('h2', { text: 'New application' })),
    note('A new service with nothing to move: pick what it is, who owns it and the load it takes. The engine recommends a cloud from your constraints, and the components are sized from the load (planning assumptions, marked as such).'),
    fields, hint,
    el('h3', { text: 'Load profile', style: { fontSize: '1rem', margin: 'var(--space-3) 0 var(--space-2)' } }),
    loadProfileForm(load, (l) => { load = l; }),
    el('div', { class: 'btn-row', style: { flexWrap: 'wrap', marginTop: 'var(--space-3)' } }, go, onCancel ? button('Cancel', onCancel) : null),
    message);
}

export { setLoadProfile };
