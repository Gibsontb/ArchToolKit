/**
 * The workspace's Assessment tab (addendum A.2.2 item 4, A.10.17): readiness
 * and complexity, said in the chosen provider's own vocabulary
 * (PROVIDER_TERMS: Azure Migrate's Ready / Conditionally ready / Not ready /
 * Readiness unknown, OCI's ERROR / WARNING / INFO, AWS's confidence score and
 * risk flags …).
 *
 * Readiness is computed, never rated: 100 − 25 × blockers − 10 × items past
 * end of support − 10 × items of unknown type, each deduction listed. The
 * complexity score (A.10.17), AWS's migration complexity sheet and the Azure
 * value-by-effort quadrant sit beside it, then the pattern's own questions
 * (SAP SIDs, VDI users …), the 6R route, and the pattern's facts with the
 * [U] / [C] mark on any that are not verified from the vendor's documentation.
 */

import { el, append } from '../dom.js';
import { renderBlueprintForm } from '../blueprint-form.js';
                                                             
import { AWS_COMPLEXITY_CRITERIA, awsAnswerKey, awsComplexityScore, valueEffortMatrix, VALUE_ANSWER_KEY } from '../../multicloud/plan/governance/complexity.js';
import { PROVIDER_TERMS, providerTerm } from '../../multicloud/plan/methodology.js';
import { DISPOSITION_OPTIONS, PROVIDER_TERM_OPTIONS, PROVIDER_TERM_VALUES } from '../../multicloud/plan/options.js';
import { PATTERN_CATALOG } from '../../multicloud/plan/patterns/index.js';
                                                                  
import { COMPARE_PLATFORMS, PLATFORM_NAME, appReadiness, editAppPlan, providerReadiness, safeComplexity, setAnswer } from './app-model.js';
import { chip, dropdown, factBadge, judgedOn, labelled, note, rowsTable, sourceLink,                         } from './kit.js';

const bandTone = (b        )       => (b === 'High' ? 'danger' : b === 'Medium' ? 'warn' : 'good');
const SCALE = ['1', '2', '3', '4', '5'].map((v) => ({ value: v, label: v }));

export function renderAssessment(view         )              {
  const { app, appPlan: ap, platform: p, plan } = view;
  const on = judgedOn(plan);
  const r = appReadiness(plan, app.id, on);
  const said = providerReadiness(p, r);
  const cx = safeComplexity(plan, app.name, on);
  const ve = (() => {
    try {
      return valueEffortMatrix(plan, { on }).find((x) => x.app === app.name);
    } catch {
      return undefined;
    }
  })();
  const aws = (() => {
    try {
      return awsComplexityScore(plan, app.name, ap.answers, on);
    } catch {
      return undefined;
    }
  })();
  const entry = PATTERN_CATALOG[app.pattern ?? 'generic'] ?? PATTERN_CATALOG.generic;

  // The pattern's questions, as a form over AppPlan.answers.
  const qInputs                   = entry.questions.map((q) => ({
    id: q.key, label: q.label,
    control: q.kind === 'select' ? 'select' : q.kind === 'yesno' ? 'select' : q.kind === 'number' ? 'number' : 'text',
    ...(q.kind === 'select' ? { options: (q.options ?? []).map((o) => ({ value: o, label: o })), blankLabel: q.default ? `(${q.default})` : '(not answered)' } : {}),
    ...(q.kind === 'yesno' ? { options: [{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }], blankLabel: q.default ? `(${q.default})` : '(not answered)' } : {}),
    ...(q.unit ? { hint: q.unit } : {}),
    ...(q.default && q.kind !== 'select' && q.kind !== 'yesno' ? { placeholder: q.default } : {}),
  }));
  let answers                         = { ...ap.answers };
  const qForm = el('div', { class: 'two', attrs: { 'data-control': 'pattern-questions' } });
  append(qForm, ...renderBlueprintForm({ inputs: qInputs }, {
    values: () => answers,
    set: (id, v) => {
      answers = { ...answers, [id]: v };
      view.edit((pl) => setAnswer(pl, app.id, id, v));
    },
  }));

  return el('div', {},
    el('section', { class: 'card', attrs: { 'data-control': 'readiness' } },
      el('div', { class: 'card-title' }, el('h2', { text: `Readiness on ${PLATFORM_NAME[p]}` })),
      el('p', {}, el('strong', { text: `${said.term}: ` }), chip(said.verdict, r.blockers > 0 ? 'danger' : r.eol + r.unknown > 0 ? 'warn' : 'good'), ` (computed ${r.score} / 100)`),
      note('Computed, never rated: 100 − 25 × blockers − 10 × items past end of support − 10 × items of unknown type.'),
      rowsTable(['Deduction', 'Points'], r.deductions.map((d) => [d.label, `−${d.points}`]), { empty: 'No deductions.', numeric: [1] }),
      el('details', {}, el('summary', { class: 'small', text: 'The same, in each provider\'s words' }),
        rowsTable(['Cloud', 'Their term', 'Verdict'], COMPARE_PLATFORMS.map((x) => {
          const s = providerReadiness(x, r);
          return [PLATFORM_NAME[x], PROVIDER_TERMS.readiness[x] ?? s.term, s.verdict];
        })))),
    el('section', { class: 'card', attrs: { 'data-control': 'complexity' } },
      el('div', { class: 'card-title' }, el('h2', { text: 'Complexity' })),
      el('p', {}, chip(`Score ${cx.score}`, bandTone(cx.band)), chip(`${cx.band} complexity`, bandTone(cx.band)), chip(`Risk ${cx.risk}`, bandTone(cx.risk)),
        ve ? chip(`${ve.label} (wave ${ve.wave})`, ve.quadrant === 'quick-win' ? 'good' : ve.quadrant === 'defer' ? 'danger' : 'neutral', `Value ${ve.value} (${ve.valueBasis}), effort ${ve.effort}: ${ve.effortBasis}`) : null),
      rowsTable(['Factor', 'Quantity', 'Points'], cx.factors.map((f) => [f.label, String(f.quantity), String(f.points)]), { numeric: [2] }),
      el('div', { style: { maxWidth: '22rem', marginTop: 'var(--space-3)' } },
        labelled('Business value (value-by-effort matrix)', dropdown([{ value: 'high', label: 'High' }, { value: 'low', label: 'Low' }], ap.answers[VALUE_ANSWER_KEY] ?? '', (v) => view.edit((pl) => setAnswer(pl, app.id, VALUE_ANSWER_KEY, v), { redraw: true }), { blank: '(assumed from criticality)', control: 'assessment-value' }))),
      note(`Source: ${cx.source}`),
      aws ? el('details', { attrs: { 'data-control': 'aws-complexity' } },
        el('summary', { class: 'small', text: `AWS migration complexity sheet: ${aws.total} (business ${aws.business}, technical ${aws.technical}; ${aws.scored} of ${AWS_COMPLEXITY_CRITERIA.length} scored)` }),
        rowsTable(['Criterion', 'Group', 'Score', 'Basis'], aws.criteria.map((c) => [
          c.label, c.group,
          dropdown(SCALE, ap.answers[awsAnswerKey(c.id)] ?? '', (v) => view.edit((pl) => setAnswer(pl, app.id, awsAnswerKey(c.id), v), { redraw: true }), { blank: c.score !== undefined && c.basis === 'derived' ? `(derived: ${c.score})` : '(not scored)', label: c.label }),
          c.basis === 'derived' ? el('span', { class: 'small' }, chip('derived', 'warn', 'The toolkit\'s thresholds (an assumption)'), ` ${c.why ?? ''}`) : c.basis,
        ])), note(`Source: ${aws.source}`)) : null),
    el('section', { class: 'card' },
      el('div', { class: 'card-title' }, el('h2', { text: 'Route and pattern' })),
      el('div', { style: { maxWidth: '22rem' } }, labelled('Route (6R)', dropdown(DISPOSITION_OPTIONS.filter((o) => o.value !== 'new'), ap.route ?? '', (v) => view.edit((pl) => editAppPlan(pl, app.id, (x) => {
        const { route: _r, ...rest } = x;
        return v ? { ...rest, route: v                } : rest;
      })), { blank: '(decided per item)', control: 'assessment-route' }))),
      qInputs.length > 0 ? el('div', {}, el('h3', { text: 'The pattern\'s questions', style: { fontSize: '1rem', margin: 'var(--space-3) 0 var(--space-2)' } }), qForm) : note('This pattern asks no questions.'),
      entry.facts.length > 0 ? el('div', {}, el('h3', { text: 'What the pattern rests on', style: { fontSize: '1rem', margin: 'var(--space-3) 0 var(--space-2)' } }),
        el('ul', {}, ...entry.facts.map((f) => el('li', { class: 'small' }, `${f.text} `, factBadge(f.verification, f.source), ' ', sourceLink(f.source))))) : null),
    el('section', { class: 'card' },
      el('div', { class: 'card-title' }, el('h2', { text: `${PLATFORM_NAME[p]}'s words` })),
      note('The provider\'s own name for each concept, used when this cloud is chosen.'),
      rowsTable(['Concept', PLATFORM_NAME[p]], PROVIDER_TERM_VALUES.map((t) => [PROVIDER_TERM_OPTIONS.find((o) => o.value === t)?.label ?? t, providerTerm(t, p)]))));
}
