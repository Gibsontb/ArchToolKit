/**
 * Sizing (addendum A.2.8): the workspace's Sizing tab (one app) and the
 * `#sizing` pane (every app, and the policy).
 *
 * Every component is sized by each engine that applies (servers, volumes,
 * Kubernetes, databases, SAP, VDI, file, VCF hosts, and the load model for new
 * apps). Each row carries its demand, the recommendation, whether it fits, the
 * reasons and up to three alternatives, and an Override (a dropdown of the
 * engine's choices and the size's family, or any value typed). Overrides are
 * stored in `Plan.sizing.overrides` and win over the engines; one that fails
 * the demand is kept with a warning. **Accept all** clears them.
 *
 * `#sizing` holds the policy — every field a dropdown (the options from
 * options.ts) — the load engine's planning assumptions, and one grid across
 * all apps with filters, bulk Accept and the totals.
 */

import { el, append } from '../dom.js';
                                                    
import { findingsList } from '../components.js';
import { renderBlueprintForm } from '../blueprint-form.js';
                                                                           
import {
  DISK_BASIS_OPTIONS, GROWTH_PCT_YEAR_OPTIONS, HEADROOM_PCT_OPTIONS, HEADROOM_STYLE_OPTIONS, HORIZON_YEARS_OPTIONS, INSTANCE_FAMILY_OPTIONS,
  PERCENTILE_OPTIONS, RESOURCE_STRATEGY_OPTIONS, SIZING_CONCERN_OPTIONS, SIZING_MODE_OPTIONS, SIZING_POLICY_BASIS_OPTIONS, YES_NO_OPTIONS, labelOf,
} from '../../multicloud/plan/options.js';
import { CONFIDENCE_WARN } from '../../multicloud/plan/sizing/index.js';
import { LOAD_ASSUMPTIONS } from '../../multicloud/plan/sizing/load.js';
                                                                                                      
import {
  PLATFORM_CHOICES, PLATFORM_NAME, appHash, appSizingRows, clearOverrides, estateSizingRows, overrideChoices, policyOfPlan, recommendationsOf,
  setAssumption, setOverride, setPolicy,                    
} from './app-model.js';
import { button, buttonRow, chip, combo, dropdown, fill, filterRow, labelled, note, rowsTable, textInput, watchPlan,                            } from './kit.js';

// ---------------------------------------------------------------------------
// The policy
// ---------------------------------------------------------------------------

const PCT_TARGETS                          = ['50', '60', '65', '70', '75', '80', '85', '90', '95', '100'].map((v) => ({ value: v, label: `${v}%` }));
const BENCHMARK                          = ['0.5', '0.75', '0.9', '1', '1.1', '1.25', '1.5', '2'].map((v) => ({ value: v, label: `× ${v}` }));

/** The policy as blueprint inputs: every field a dropdown (families a tick list). */
export const POLICY_INPUTS                            = [
  { id: 'basis', label: 'Basis', control: 'select', options: SIZING_POLICY_BASIS_OPTIONS },
  { id: 'mode', label: 'Sizing mode', control: 'select', options: SIZING_MODE_OPTIONS, blankLabel: '(from the basis)' },
  { id: 'percentile', label: 'Percentile', control: 'select', options: PERCENTILE_OPTIONS },
  { id: 'cpuStrategy', label: 'CPU statistic', control: 'select', options: RESOURCE_STRATEGY_OPTIONS, blankLabel: '(the percentile)' },
  { id: 'memoryStrategy', label: 'Memory statistic', control: 'select', options: RESOURCE_STRATEGY_OPTIONS, blankLabel: '(the percentile)' },
  { id: 'headroomStyle', label: 'Headroom style', control: 'select', options: HEADROOM_STYLE_OPTIONS, blankLabel: '(comfort factor)' },
  { id: 'headroomPct', label: 'Headroom', control: 'select', options: HEADROOM_PCT_OPTIONS },
  { id: 'cpuTargetPct', label: 'CPU target utilisation', control: 'select', options: PCT_TARGETS, blankLabel: '(not used)', showWhen: { input: 'headroomStyle', equals: ['target-utilisation'] } },
  { id: 'memoryTargetPct', label: 'Memory target utilisation', control: 'select', options: PCT_TARGETS, blankLabel: '(not used)', showWhen: { input: 'headroomStyle', equals: ['target-utilisation'] } },
  { id: 'benchmarkMultiplier', label: 'CPU benchmark multiplier', control: 'select', options: BENCHMARK, blankLabel: '(× 1)', hint: 'source ÷ target CPU score' },
  { id: 'diskBasis', label: 'Disk size basis', control: 'select', options: DISK_BASIS_OPTIONS },
  { id: 'growthPctYear', label: 'Storage growth', control: 'select', options: GROWTH_PCT_YEAR_OPTIONS },
  { id: 'horizonYears', label: 'Growth horizon', control: 'select', options: HORIZON_YEARS_OPTIONS },
  { id: 'families', label: 'Families allowed', control: 'checklist', options: INSTANCE_FAMILY_OPTIONS },
  { id: 'burstableInProd', label: 'Burstable in production', control: 'select', options: YES_NO_OPTIONS },
  { id: 'allowArm', label: 'Also Arm (Graviton, Cobalt, Axion, Ampere)', control: 'select', options: YES_NO_OPTIONS },
  { id: 'latestGeneration', label: 'Latest generation only', control: 'select', options: YES_NO_OPTIONS },
  { id: 'licenceOptimised', label: 'Licence-optimised cores for BYOL hosts', control: 'select', options: YES_NO_OPTIONS },
];

const BOOL = new Set(['burstableInProd', 'allowArm', 'latestGeneration', 'licenceOptimised']);
const NUM = new Set(['headroomPct', 'growthPctYear', 'horizonYears', 'cpuTargetPct', 'memoryTargetPct', 'benchmarkMultiplier']);

export function policyValues(p              )                         {
  const out                         = {};
  for (const i of POLICY_INPUTS) {
    const v = (p                                      )[i.id];
    if (v === undefined) continue;
    out[i.id] = BOOL.has(i.id) ? (v ? 'yes' : 'no') : Array.isArray(v) ? v.join(', ') : String(v);
  }
  return out;
}

/** One policy field from its dropdown's value (blank clears an optional field). */
export function policyPatch(id        , value        )                        {
  if (BOOL.has(id)) return { [id]: value === 'yes' }                         ;
  if (id === 'families') return { families: value.split(',').map((s) => s.trim()).filter(Boolean)                             };
  if (value === '') return { [id]: undefined }                         ;
  return { [id]: NUM.has(id) ? Number(value) : value }                         ;
}

function policyCard(ctx             , watcher         )              {
  let values = policyValues(policyOfPlan(ctx.session.plan()));
  const form = el('div', { class: 'two', attrs: { 'data-control': 'sizing-policy' } });
  const drawForm = () => form.replaceChildren(...renderBlueprintForm({ inputs: POLICY_INPUTS }, {
    values: () => values,
    set: (id, v) => {
      values = { ...values, [id]: v };
      watcher.edit((p) => setPolicy(p, policyPatch(id, v)));
    },
    rerender: drawForm,
  }));
  drawForm();
  return el('section', { class: 'card' },
    el('div', { class: 'card-title' }, el('h2', { text: 'Sizing policy' })),
    note(`Utilisation is used where coverage is at least 60% over at least 3 days; below ${Math.round(CONFIDENCE_WARN * 100)}% the row carries a data-confidence warning. SAP, database and large-memory apps size at p99.`),
    form);
}

function assumptionsCard(ctx             , watcher         )              {
  const current = policyOfPlan(ctx.session.plan()).assumptions;
  const rows = Object.entries(LOAD_ASSUMPTIONS).map(([k, def]) => [
    el('code', { text: k }),
    String(def),
    textInput(current[k] !== undefined ? String(current[k]) : '', (v) => watcher.edit((p) => setAssumption(p, k, v.trim() === '' ? NaN : Number(v))), { type: 'number', label: `Assumption ${k}`, placeholder: String(def) }),
  ]);
  return el('section', { class: 'card', attrs: { 'data-control': 'sizing-assumptions' } },
    el('div', { class: 'card-title' }, el('h2', { text: 'Assumptions (load model)' })),
    note('The new-application load model\'s planning assumptions. Replace them with your load-test numbers; blank uses the default.'),
    rowsTable(['Assumption', 'Default', 'Yours'], rows));
}

// ---------------------------------------------------------------------------
// The grids
// ---------------------------------------------------------------------------

function basisChip(r               )                     {
  if (!r.basis && r.coveragePct === undefined) return null;
  const low = r.coveragePct !== undefined && r.coveragePct < CONFIDENCE_WARN * 100;
  return chip(`${r.basis || 'allocated'}${r.coveragePct !== undefined ? ` (${r.coveragePct}%)` : ''}`, low ? 'warn' : r.assumption ? 'warn' : 'neutral', low ? 'Data confidence below 80%: treat the recommendation with care' : r.assumption ? 'Planning assumption: replace with your load-test numbers' : undefined);
}

function overrideCell(r               , edit                                      )              {
  return combo(overrideChoices(r.platform            , r), r.override, (v) => edit(r.key, v === r.engineChoice ? '' : v), `Override ${r.key}`);
}

const reasonCell = (r               )              => el('details', {}, el('summary', { class: 'small', text: r.reason.length > 60 ? `${r.reason.slice(0, 60)}…` : r.reason || '—' }), el('p', { class: 'small', text: r.reason }));

/** The workspace's Sizing tab. */
export function renderSizingTab(view         )              {
  const { app, platform: p } = view;
  const { rows, findings } = appSizingRows(view.plan, app.id, p);
  const edit = (key        , value        ) => view.edit((pl) => setOverride(pl, key, value));
  const byConcern = new Map                         ();
  for (const r of rows) byConcern.set(r.concern, [...(byConcern.get(r.concern) ?? []), r]);
  const sections = [...byConcern.entries()].map(([concern, list]) => el('div', { attrs: { 'data-concern': concern } },
    el('h3', { text: labelOf(SIZING_CONCERN_OPTIONS, concern), style: { fontSize: '1rem', margin: 'var(--space-4) 0 var(--space-2)' } }),
    rowsTable(['Item', 'Demand', 'Recommendation', 'Fits', 'Reason', 'Alternatives', 'Override', 'Basis'], list.map((r) => [
      el('span', {}, r.item, el('div', { class: 'small muted', text: r.component })),
      r.demand,
      el('strong', { text: r.recommendation || '—' }),
      r.fits ? chip('fits', 'good') : chip('does not fit', 'danger'),
      reasonCell(r),
      r.alternatives.join(', '),
      overrideCell(r, edit),
      basisChip(r),
    ]), { control: 'sizing-grid' })));
  const overridden = rows.filter((r) => r.override).length;
  return el('section', { class: 'card', attrs: { 'data-control': 'app-sizing' } },
    el('div', { class: 'card-title' }, el('h2', { text: `Sizing on ${PLATFORM_NAME[p]}` })),
    note('Every component, sized by each engine that applies, with the reasons. An override wins over the engine and is kept even when it fails the demand (with a warning). The policy is on the Sizing page.'),
    buttonRow(
      button(`Accept all (clear ${overridden} override${overridden === 1 ? '' : 's'})`, () => view.edit((pl) => clearOverrides(pl, rows.map((r) => r.key)), { redraw: true }), { control: 'sizing-accept-all', disabled: overridden === 0 }),
      button('Sizing policy', () => view.ctx.go('sizing'))),
    rows.length === 0 ? note('Nothing to size: add components first.') : null,
    ...sections,
    findings.length > 0 ? findingsList(findings) : null);
}

// ---------------------------------------------------------------------------
// #sizing
// ---------------------------------------------------------------------------

export function mount(root             , ctx             )       {
  let filter = { text: '', platform: '', concern: '', overridden: '' };
  let recs                                    = {};
  let recsFor                  ;
  const policySlot = el('div');
  const gridSlot = el('div');
  const assumeSlot = el('div');
  append(root, policySlot, gridSlot, assumeSlot);

  const draw = () => {
    fill(policySlot, policyCard(ctx, watcher));
    fill(assumeSlot, assumptionsCard(ctx, watcher));
    drawGrid();
  };

  function drawGrid()       {
    const plan = ctx.session.plan();
    if (recsFor !== plan) {
      recs = recommendationsOf(plan);
      recsFor = plan;
    }
    const { rows, findings } = estateSizingRows(plan, recs);
    const q = filter.text.trim().toLowerCase();
    const shown = rows.filter((r) => (!q || `${r.app} ${r.item}`.toLowerCase().includes(q))
      && (!filter.platform || r.platform === filter.platform)
      && (!filter.concern || r.concern === filter.concern)
      && (!filter.overridden || (filter.overridden === 'yes') === !!r.override));
    const edit = (key        , value        ) => watcher.edit((p) => setOverride(p, key, value));
    const sum = (f                                          ) => Math.round(shown.reduce((s, r) => s + (f(r) ?? 0), 0) * 10) / 10;
    const redrawGrid = () => drawGrid();
    fill(gridSlot, el('section', { class: 'card', attrs: { 'data-control': 'estate-sizing' } },
      el('div', { class: 'card-title' }, el('h2', { text: 'Every application\'s sizing' })),
      filterRow(
        labelled('Search', textInput(filter.text, (v) => { filter = { ...filter, text: v }; redrawGrid(); }, { placeholder: 'App or item', label: 'Search sizing rows' })),
        labelled('Cloud', dropdown(PLATFORM_CHOICES, filter.platform, (v) => { filter = { ...filter, platform: v }; redrawGrid(); }, { blank: 'Any cloud', label: 'Cloud' })),
        labelled('Concern', dropdown(SIZING_CONCERN_OPTIONS, filter.concern, (v) => { filter = { ...filter, concern: v }; redrawGrid(); }, { blank: 'Every concern', label: 'Concern' })),
        labelled('Overridden', dropdown(YES_NO_OPTIONS, filter.overridden, (v) => { filter = { ...filter, overridden: v }; redrawGrid(); }, { blank: 'Either', label: 'Overridden' }))),
      el('p', { class: 'small', attrs: { 'data-control': 'sizing-totals' }, text: `${shown.length} of ${rows.length} rows · ${shown.filter((r) => r.override).length} overridden · ${shown.filter((r) => !r.fits).length} do not fit · Δ vCPU ${sum((r) => r.deltaVcpu)} · Δ RAM ${sum((r) => r.deltaRam)} GiB (recommendation − source allocation)` }),
      buttonRow(button('Accept the shown rows (clear their overrides)', () => watcher.edit((p) => clearOverrides(p, shown.map((r) => r.key)), { redraw: true }), { control: 'sizing-bulk-accept' })),
      rowsTable(['App', 'Item', 'Cloud', 'Demand', 'Recommendation', 'Override', 'Δ vCPU', 'Δ RAM', 'Reason'], shown.slice(0, 400).map((r) => [
        el('a', { text: r.app, attrs: { href: `#${appHash({ id: r.appId }, 'sizing')}` } }),
        el('span', {}, r.item, el('div', { class: 'small muted', text: labelOf(SIZING_CONCERN_OPTIONS, r.concern) })),
        PLATFORM_NAME[r.platform],
        r.demand,
        el('span', {}, el('strong', { text: r.recommendation || '—' }), r.fits ? null : chip('does not fit', 'danger'), basisChip(r)),
        overrideCell(r, edit),
        r.deltaVcpu === undefined ? '' : String(r.deltaVcpu),
        r.deltaRam === undefined ? '' : String(r.deltaRam),
        reasonCell(r),
      ]), { control: 'estate-sizing-grid', numeric: [6, 7], empty: rows.length === 0 ? 'No application has components to size yet.' : 'No row matches the filters.' }),
      shown.length > 400 ? note(`The first 400 of ${shown.length} rows are listed; filter for the rest.`) : null,
      findings.length > 0 ? el('details', {}, el('summary', { class: 'small', text: `${findings.length} sizing finding(s)` }), findingsList(findings)) : null));
  }

  const watcher          = watchPlan(root, ctx, draw);
  draw();
}
