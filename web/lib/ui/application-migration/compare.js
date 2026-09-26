/**
 * The workspace's Compare tab (addendum A.2.3, A.2.7): the app side by side
 * on AWS, Azure, Google Cloud (GCP), OCI and VMware Cloud Foundation (VCF),
 * from `compareApp` — each column the app's slice decided and designed with
 * that cloud chosen, at the sized shapes.
 *
 * Rows: the verdict (eligible, eligible with gaps, or not; score and delta to
 * the recommendation; **Choose this cloud**), why (the top rule hits, with the
 * [U] / [C] mark and the source), one row per component (what it becomes
 * there and the translation status: mapped / partial / no-equivalent, with
 * the arguments not carried), licences, the sized footprint, the estimate
 * (only with your rate card), what to stand up first, the migration path, the
 * findings and, for an ineligible cloud, what eliminated it.
 *
 * A cloud not among the allowed platforms is still compared (so all five are
 * side by side) and marked "not allowed"; choosing it is then refused.
 * Choosing a cloud keeps every variant, so switching back restores the
 * original components exactly.
 */

import { el, append } from '../dom.js';
                                       
import { findingsList } from '../components.js';
import { compareApp,                                        } from '../../multicloud/plan/apps/compare.js';
import { appPlanOf } from '../../multicloud/plan/apps/components.js';
import { chooseAppPlatform } from '../../multicloud/plan/apps/recommend.js';
import { LICENCE_KIND_OPTIONS, LICENCE_MODEL_OPTIONS, TIER_PATTERN_OPTIONS, labelOf } from '../../multicloud/plan/options.js';
                                                                     
import { COMPARE_PLATFORMS, PLATFORM_NAME } from './app-model.js';
import { button, chip, factBadge, note, sourceLink,                         } from './kit.js';

/** `compareApp` over the given platforms (default: all five), allowed or not. */
export function compareAll(plan      , appId        , platforms                      = COMPARE_PLATFORMS)                {
  const inAllowed = platforms.filter((p) => plan.requirements.allowed.includes(p));
  const outside = platforms.filter((p) => !plan.requirements.allowed.includes(p));
  const base = compareApp(plan, appId, { platforms: inAllowed });
  if (outside.length === 0) return base;
  // The others are compared as if allowed, but never recommended: the recommendation stays the allowed platforms'.
  const wide       = { ...plan, requirements: { ...plan.requirements, allowed: [...plan.requirements.allowed, ...outside] } };
  const extra = compareApp(wide, appId, { platforms: outside });
  const recScore = base.recommendation.recommended ? base.recommendation.perPlatform.find((x) => x.platform === base.recommendation.recommended)?.score ?? 0 : 0;
  const columns = [...base.columns, ...extra.columns.map((c) => ({ ...c, verdict: { ...c.verdict, recommended: false, delta: c.verdict.score - recScore } }))];
  return { ...base, columns: platforms.map((p) => columns.find((c) => c.platform === p)).filter((c)                     => !!c) };
}

export const OUTCOME_TONE                                 = { mapped: 'good', partial: 'warn', 'no-equivalent': 'danger' };

/** Per app: the last switch's message. */
const LAST = new Map                ();

/** Choose a cloud for the app; the message says whether its variant was selected unchanged or translated. */
export function choose(view         , p          )       {
  const plan = view.current();
  if (!plan.requirements.allowed.includes(p)) {
    LAST.set(view.app.id, `${PLATFORM_NAME[p]} is not among the allowed platforms: allow it on Constraints first.`);
    view.redraw();
    return;
  }
  const r = chooseAppPlatform(plan, view.app.id, p);
  const errors = r.findings.filter((f) => f.severity === 'error').length;
  LAST.set(view.app.id, `${r.logEntry} ${r.created ? `Its ${PLATFORM_NAME[p]} components were translated from the current cloud${errors > 0 ? ` (${errors} with no equivalent: see Components)` : ''}.` : `Its saved ${PLATFORM_NAME[p]} components were selected unchanged.`}`);
  view.edit(() => r.plan, { redraw: true });
}

export const lastSwitch = (appId        )                     => LAST.get(appId);

function verdictCell(view         , c               , allowed         )              {
  const v = c.verdict;
  return el('div', {},
    el('div', {},
      !allowed ? chip('not allowed', 'warn', 'Not among the allowed platforms (Constraints)') : null,
      v.eligible ? chip(v.withGaps ? 'eligible, with gaps' : 'eligible', v.withGaps ? 'warn' : 'good') : chip('not eligible', 'danger'),
      v.recommended ? chip('recommended', 'good') : null,
      v.chosen ? chip('chosen', 'good') : null),
    el('div', { class: 'small', text: `Score ${v.score}${v.recommended ? '' : ` (${v.delta >= 0 ? '+' : ''}${v.delta} to the recommendation)`}` }),
    v.chosen ? null : button('Choose this cloud', () => choose(view, c.platform), { small: true, control: 'compare-choose', disabled: !allowed }));
}

const list = (items                  )              => el('ul', { style: { margin: '0', paddingLeft: '1.1rem' } }, ...items.map((i) => el('li', { class: 'small' }, i)));

export function renderCompare(view         )              {
  const { app } = view;
  const cmp = compareAll(view.plan, app.id);
  const cols = cmp.columns;
  const allowed = new Set(view.plan.requirements.allowed);
  const componentNames = [...new Map(cols.flatMap((c) => c.components.map((k) => [k.componentId, k.name]         ))).entries()];

  const rows                                          = [
    ['Verdict', (c) => verdictCell(view, c, allowed.has(c.platform))],
    ['Why', (c) => c.why.length === 0 ? el('span', { class: 'small muted', text: 'No rule scored it.' }) : list(c.why.map((h) => el('span', {}, `${h.reason} (${h.delta > 0 ? '+' : ''}${h.delta}) `, factBadge(h.verification, h.source), ' ', sourceLink(h.source))))],
    ...componentNames.map(([id, name])                                        => [`Component: ${name}`, (c) => {
      const k = c.components.find((x) => x.componentId === id);
      if (!k) return el('span', { class: 'small muted', text: '—' });
      return el('div', { attrs: { 'data-control': 'compare-component', 'data-outcome': k.outcome } },
        el('div', { class: 'small' }, k.tierPattern ? `${labelOf(TIER_PATTERN_OPTIONS, k.tierPattern)}: ` : '', k.service || k.targetTypes.join(' + ')),
        k.sizes.length > 0 ? el('div', { class: 'small muted', text: k.sizes.join(', ') }) : null,
        chip(k.outcome, OUTCOME_TONE[k.outcome] ?? 'neutral', k.reason),
        k.carried + k.dropped.length > 0 ? el('span', { class: 'small', text: ` ${k.carried} carried, ${k.dropped.length} not` }) : null,
        k.dropped.length > 0 ? el('details', {}, el('summary', { class: 'small', text: 'Not carried' }), list(k.dropped.map((d) => `${d.argument} = ${d.value}: ${d.reason}`))) : null,
        k.proposal ? el('div', { class: 'small', text: `Proposed instead: ${labelOf(TIER_PATTERN_OPTIONS, k.proposal)}` }) : null,
        k.outcome === 'no-equivalent' && k.reason ? el('div', { class: 'small muted', text: k.reason }) : null);
    }]),
    ['Licences', (c) => c.licences.length === 0 ? el('span', { class: 'small muted', text: 'None needed' }) : list(c.licences.map((l) => `${l.count} ${labelOf(LICENCE_KIND_OPTIONS, l.kind)} (${labelOf(LICENCE_MODEL_OPTIONS, l.model)})`))],
    ['Footprint (sized)', (c) => list([
      `${c.footprint.vcpu} vCPU, ${c.footprint.ramGib} GiB RAM`,
      ...c.footprint.storage.map((s) => `${s.gib} GiB ${s.type}`),
      ...(c.footprint.dbInstances > 0 ? [`${c.footprint.dbInstances} database instance(s)`] : []),
      ...(c.footprint.nodePools > 0 ? [`${c.footprint.nodePools} Kubernetes node pool(s)`] : []),
      ...(c.footprint.managedServices.length > 0 ? [`Managed: ${c.footprint.managedServices.join(', ')}`] : []),
    ])],
    ...(cols.some((c) => c.estimate) ? [['Estimate (your rates)', (c               ) => c.estimate ? el('div', { class: 'small' }, c.estimate.label, list([...c.estimate.monthly.map((m) => `${m.amount} ${m.currency} a month`), ...c.estimate.oneTime.map((m) => `${m.amount} ${m.currency} one-time`)])) : '—']                                         ] : []),
    ['To stand up first', (c) => list(c.standUpFirst.map((s) => el('span', {}, s.exists ? chip('exists', 'good') : chip('missing', 'warn'), ` ${s.what}`)))],
    ['Migration path', (c) => c.migrationPath.length === 0 ? '—' : list(c.migrationPath.map((m) => `${m.item}: ${m.method}${m.downtime !== 'n/a' ? ` (downtime: ${m.downtime})` : ''}`))],
    ['Findings', (c) => el('div', {},
      el('span', {}, chip(`${c.findings.error} errors`, c.findings.error > 0 ? 'danger' : 'neutral'), chip(`${c.findings.warning} warnings`, c.findings.warning > 0 ? 'warn' : 'neutral'), chip(`${c.findings.info} notes`)),
      c.findings.list.length > 0 ? el('details', {}, el('summary', { class: 'small', text: 'Show' }), findingsList(c.findings.list)) : null)],
    ['Eliminated because', (c) => c.eliminatedBecause.length === 0 ? '—' : list(c.eliminatedBecause.map((e) => `${e.item}: ${e.rules.map((r) => r.reason).join('; ')}`))],
  ];

  const body = el('tbody');
  for (const [label, cell] of rows) {
    const tr = el('tr', {}, el('th', { text: label, attrs: { scope: 'row' }, style: { textAlign: 'left', verticalAlign: 'top', minWidth: '8rem' } }));
    for (const c of cols) append(tr, el('td', { style: { verticalAlign: 'top', minWidth: '12rem' } }, cell(c)));
    append(body, tr);
  }
  const variants = appPlanOf(view.plan, app.id)?.variants ?? {};
  const kept = COMPARE_PLATFORMS.filter((p) => variants[p]);
  const last = lastSwitch(app.id);
  return el('section', { class: 'card', attrs: { 'data-control': 'compare' } },
    el('div', { class: 'card-title' }, el('h2', { text: 'Compare the clouds' })),
    note('Each column is this application decided and designed on that cloud, at its sized shapes. A component\'s status is its translation from the current cloud: mapped, partial (some arguments not carried), or no-equivalent (it would need replacing).'),
    el('div', { class: 'pill-row', attrs: { 'data-control': 'compare-variants' } },
      el('span', { class: 'small', text: 'Component sets kept:' }),
      ...(kept.length > 0 ? kept.map((p) => chip(PLATFORM_NAME[p], view.appPlan.platform === p ? 'good' : 'neutral')) : [chip('none yet')])),
    last ? el('p', { class: 'small', text: last, attrs: { role: 'status', 'data-control': 'compare-message' } }) : null,
    el('div', { class: 'table-wrap' },
      el('table', {}, el('thead', {}, el('tr', {}, el('th', { text: '' }), ...cols.map((c) => el('th', { text: PLATFORM_NAME[c.platform], attrs: { 'data-platform': c.platform } })))), body)));
}
