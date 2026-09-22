/**
 * Application migration, and the portfolio of what has been evaluated.
 *
 * These were two pages: one that evaluated an application and exported a JSON
 * record, and a dashboard that imported those records to plan waves. Nothing
 * connected them, so the second was always out of date. Here they are one
 * page with a Portfolio tab: evaluating an application adds or replaces its
 * row, the waves are recalculated from what is held, and the old dashboard
 * address redirects to this tab.
 *
 * The rules — the readiness score, the seven routes, the target cloud, the
 * risk points, the playbook, the wave bands — are in `src/migration/`, with
 * tests. This file is the page around them: the form, the tabs, the table and
 * the files that go in and out.
 */

import { append, clear, downloadFile, el, must, readFileAsText, replace } from './dom.ts';
import { card, checkbox, field, findingsList, numberInput, select, stat, statGrid, type StatTone } from './components.ts';
import { fileBar } from './file-bar.ts';
import type { Finding } from '../core/findings.ts';
import type { Json } from '../editor/doc.ts';
import {
  CLOUDS,
  CLOUD_LABELS,
  COMPLIANCE,
  CRITICALITY,
  GATES,
  SUGGESTED_DATABASES,
  SUGGESTED_HOSTING,
  SUGGESTED_IDENTITY,
  SUGGESTED_INTEGRATIONS,
  SUGGESTED_OS_RUNTIMES,
  SUGGESTED_PATTERNS,
  SUGGESTED_STACKS,
  SUGGESTED_VENDORS,
  WORKLOAD_TYPES,
  type Cloud,
  type Criticality,
} from '../migration/options.ts';
import { evaluate, RATING_MEANING, WEIGHTS } from '../migration/evaluate.ts';
import { globalCatalog } from '../migration/services.ts';
import { countWaves, wavePlan, WAVE_MEANING, WAVE_MODES, type Wave, type WaveMode } from '../migration/waves.ts';
import {
  CSV_COLUMNS,
  clearPortfolio,
  entryFor,
  exportCsv,
  exportJson,
  importCsv,
  importJson,
  loadPortfolio,
  merge,
  remove as removeEntry,
  reevaluate,
  savePortfolio,
  upsert,
} from '../migration/portfolio.ts';
import { DEFAULT_RATINGS, EMPTY_APPLICATION, NO_GATES, type Application, type Evaluation, type Gates, type PortfolioEntry, type Ratings } from '../migration/types.ts';

const catalog = globalCatalog();

interface State {
  app: Application;
  evaluation: Evaluation | null;
  entries: PortfolioEntry[];
  mode: WaveMode;
  filterCloud: Cloud | '';
  filterRoute: string;
  filterWave: string;
  /** Rows opened out to their full record. */
  expanded: Set<string>;
  notes: Finding[];
}

const state: State = {
  app: { ...EMPTY_APPLICATION },
  evaluation: null,
  entries: [],
  mode: 'default',
  filterCloud: '',
  filterRoute: '',
  filterWave: '',
  expanded: new Set<string>(),
  notes: [],
};

/* -------------------------------------------------------------------------- *
 * Small controls
 * -------------------------------------------------------------------------- */

/** A dropdown of the usual answers, with a way to type one it has not heard of. */
function combo(options: readonly string[], value: string, onChange: (next: string) => void): HTMLElement {
  const CUSTOM = '__custom__';
  const known = options.includes(value);
  const node = el('select') as HTMLSelectElement;
  append(node, el('option', { text: '(not stated)', attrs: { value: '' } }));
  for (const option of options) {
    const opt = el('option', { text: option, attrs: { value: option } }) as HTMLOptionElement;
    if (option === value) opt.selected = true;
    node.appendChild(opt);
  }
  const other = el('option', { text: 'Other — type a value…', attrs: { value: CUSTOM } }) as HTMLOptionElement;
  if (value !== '' && !known) other.selected = true;
  node.appendChild(other);

  const custom = el('input', { attrs: { type: 'text', placeholder: 'Type a value' } }) as HTMLInputElement;
  custom.value = known ? '' : value;
  custom.style.display = value !== '' && !known ? '' : 'none';
  custom.style.marginTop = 'var(--space-2)';

  node.addEventListener('change', () => {
    const typing = node.value === CUSTOM;
    custom.style.display = typing ? '' : 'none';
    if (typing) custom.focus();
    onChange(typing ? custom.value.trim() : node.value);
  });
  custom.addEventListener('input', () => onChange(custom.value.trim()));

  return el('div', { class: 'combo' }, node, custom);
}

function textInput(value: string, placeholder: string, onChange: (next: string) => void, id?: string): HTMLInputElement {
  const node = el('input', { attrs: { type: 'text', value, placeholder } }) as HTMLInputElement;
  if (id) node.id = id;
  node.addEventListener('input', () => onChange(node.value));
  return node;
}

function update(change: Partial<Application>): void {
  state.app = { ...state.app, ...change };
}

function updateGates(change: Partial<Gates>): void {
  state.app = { ...state.app, gates: { ...state.app.gates, ...change } };
}

function updateRatings(change: Partial<Ratings>): void {
  state.app = { ...state.app, ratings: { ...state.app.ratings, ...change } };
}

/* -------------------------------------------------------------------------- *
 * Intake
 * -------------------------------------------------------------------------- */

function intakeSection(rerender: () => void): HTMLElement {
  const app = state.app;

  const identity = card(
    'The application',
    el(
      'div',
      { class: 'field-grid' },
      field('Name', textInput(app.name, 'Claims Processing', (v) => update({ name: v }), 'app-name'), 'Used as the row in the portfolio: evaluating the same name again replaces it.'),
      field('Owner', textInput(app.owner, 'Finance IT', (v) => update({ owner: v }), 'app-owner')),
      field(
        'Business criticality',
        select(
          CRITICALITY.map((c) => ({ value: c, label: c })),
          app.criticality,
        ),
        'Feeds the risk band, not the route.',
      ),
      field('Workload type', combo(WORKLOAD_TYPES as unknown as string[], app.workloadType, (v) => update({ workloadType: v || EMPTY_APPLICATION.workloadType }))),
    ),
  );
  const criticality = must<HTMLSelectElement>('select', identity);
  criticality.id = 'app-criticality';
  criticality.addEventListener('change', () => update({ criticality: criticality.value as Criticality }));

  const rto = numberInput(app.rtoHours, { min: '0', step: '0.5' });
  rto.id = 'app-rto';
  rto.addEventListener('input', () => update({ rtoHours: Number(rto.value) }));
  const rpo = numberInput(app.rpoHours, { min: '0', step: '0.5' });
  rpo.id = 'app-rpo';
  rpo.addEventListener('input', () => update({ rpoHours: Number(rpo.value) }));
  const integrations = numberInput(app.integrationCount, { min: '0', step: '1' });
  integrations.addEventListener('input', () => update({ integrationCount: Number(integrations.value) }));
  const dataSize = numberInput(app.dataSizeGb, { min: '0', step: '10' });
  dataSize.addEventListener('input', () => update({ dataSizeGb: Number(dataSize.value) }));

  const service = card(
    'Service levels and size',
    el(
      'div',
      { class: 'field-grid' },
      field('RTO (hours)', rto, 'How long it may be down. Four hours or less counts as tight.'),
      field('RPO (hours)', rpo, 'How much data may be lost. One hour or less counts as tight.'),
      field('Integrations', integrations, 'How many systems it talks to. Ten or more raises the risk band.'),
      field('Data size (GB)', dataSize, 'Drives the transfer approach in the plan.'),
    ),
  );

  const technology = card(
    'Technology',
    el(
      'div',
      { class: 'field-grid' },
      field('Primary stack', combo(SUGGESTED_STACKS, app.primaryStack, (v) => update({ primaryStack: v })), 'A Microsoft stack signals Azure when nothing stronger applies.'),
      field('OS / runtime', combo(SUGGESTED_OS_RUNTIMES, app.osRuntime, (v) => update({ osRuntime: v }))),
      field('Database', combo(SUGGESTED_DATABASES, app.database, (v) => update({ database: v })), 'Decides the managed database in the recommendation.'),
      field('Hosting platform', combo(SUGGESTED_HOSTING, app.hostingPlatform, (v) => update({ hostingPlatform: v }))),
      field('Integration types', combo(SUGGESTED_INTEGRATIONS, app.integrationTypes, (v) => update({ integrationTypes: v }))),
      field('Architecture pattern', combo(SUGGESTED_PATTERNS, app.architecturePattern, (v) => update({ architecturePattern: v }))),
      field('Vendor', combo(SUGGESTED_VENDORS, app.vendor, (v) => update({ vendor: v }))),
      field('Identity', combo(SUGGESTED_IDENTITY, app.identity, (v) => update({ identity: v }))),
    ),
  );

  const standard = select<Cloud | ''>(
    [{ value: '', label: '(no standard — let the answers decide)' }, ...CLOUDS.map((c) => ({ value: c, label: CLOUD_LABELS[c] }))],
    app.enterpriseStandardCloud,
  );
  standard.id = 'app-standard-cloud';
  standard.addEventListener('change', () => update({ enterpriseStandardCloud: standard.value as Cloud | '' }));

  const complianceBoxes = el('div', { class: 'checkbox-grid' });
  for (const scope of COMPLIANCE) {
    const { wrap, input } = checkbox(scope.label, app.compliance.includes(scope.value));
    input.addEventListener('change', () => {
      const next = new Set(state.app.compliance);
      if (input.checked) next.add(scope.value);
      else next.delete(scope.value);
      update({ compliance: [...next] });
    });
    wrap.title = scope.hint;
    append(complianceBoxes, wrap);
  }

  const gateBoxes = el('div', { class: 'checkbox-grid' });
  for (const gate of GATES) {
    const key = gate.id as keyof Gates;
    const { wrap, input } = checkbox(gate.label, app.gates[key]);
    input.addEventListener('change', () => updateGates({ [key]: input.checked } as Partial<Gates>));
    wrap.title = gate.hint;
    append(gateBoxes, wrap);
  }

  const notes = el('textarea', { attrs: { rows: '3', placeholder: 'Anything the form does not ask: licensing, contracts, dependencies, a date that matters.' } }) as HTMLTextAreaElement;
  notes.value = app.notes;
  notes.addEventListener('input', () => update({ notes: notes.value }));

  const context = card(
    'Constraints and context',
    field('Enterprise standard cloud', standard, 'When the enterprise has standardised, that outranks every other signal.'),
    el('div', { class: 'field' }, el('label', { text: 'Compliance scopes' }), complianceBoxes),
    el('div', { class: 'field' }, el('label', { text: 'Hard constraints' }), el('div', { class: 'field-hint', text: 'Any of these decides the route on its own, whatever the ratings say.' }), gateBoxes),
    field('Notes', notes),
  );

  const next = el(
    'div',
    { class: 'btn-row' },
    el('button', { class: 'btn btn-primary', text: 'Next: ratings →', on: { click: () => showTab('ratings') } }),
    el('button', {
      class: 'btn',
      text: 'Evaluate & add to portfolio',
      dataset: { control: 'evaluate' },
      attrs: { title: 'Score it, route it, and put it in the portfolio' },
      on: { click: () => runEvaluation(rerender) },
    }),
  );

  return el('div', {}, identity, service, technology, context, next);
}

/* -------------------------------------------------------------------------- *
 * Ratings
 * -------------------------------------------------------------------------- */

function ratingsSection(rerender: () => void): HTMLElement {
  const wrap = el('div', {});
  const readout = el('div', { class: 'section-note' });

  const say = () => {
    const score = evaluate(state.app, catalog).readiness;
    readout.textContent = `Readiness with these ratings: ${score} out of 100.`;
  };

  const rows = el('div', {});
  for (const key of Object.keys(WEIGHTS) as (keyof Ratings)[]) {
    const meaning = RATING_MEANING[key];
    const slider = el('input', { attrs: { type: 'range', min: '1', max: '5', step: '1', value: String(state.app.ratings[key]) } }) as HTMLInputElement;
    const value = el('span', { class: 'rating-value', text: String(state.app.ratings[key]) });
    slider.addEventListener('input', () => {
      updateRatings({ [key]: Number(slider.value) } as Partial<Ratings>);
      value.textContent = slider.value;
      say();
    });
    append(
      rows,
      el(
        'div',
        { class: 'rating-row' },
        el('div', { class: 'rating-label' }, el('strong', { text: meaning.label }), el('span', { class: 'small muted', text: ` · ${WEIGHTS[key]}% of the score` })),
        el('div', { class: 'rating-control' }, slider, value),
        el('div', { class: 'small muted rating-scale' }, el('span', { text: meaning.low }), el('span', { text: meaning.high })),
      ),
    );
  }
  say();

  append(
    wrap,
    card(
      'Ratings',
      el('p', {
        class: 'muted',
        text: 'Every factor reads the same way: 1 is the worst case for a move and 5 the best. Rating something 5 always raises readiness, never lowers it.',
      }),
      rows,
      readout,
    ),
    el(
      'div',
      { class: 'btn-row' },
      el('button', { class: 'btn btn-primary', text: 'Evaluate & add to portfolio', dataset: { control: 'evaluate' }, on: { click: () => runEvaluation(rerender) } }),
      el('button', { class: 'btn', text: '← Back to intake', on: { click: () => showTab('intake') } }),
      el('button', {
        class: 'btn',
        text: 'Reset ratings',
        on: {
          click: () => {
            updateRatings(DEFAULT_RATINGS);
            rerender();
          },
        },
      }),
    ),
  );
  return wrap;
}

/* -------------------------------------------------------------------------- *
 * Results
 * -------------------------------------------------------------------------- */

const riskTone = (risk: string): StatTone => (risk === 'High' ? 'danger' : risk === 'Medium' ? 'warn' : 'ok');

function resultsSection(rerender: () => void): HTMLElement {
  const result = state.evaluation;
  if (!result) {
    return card('Results', el('p', { class: 'empty', text: 'Fill in the intake, set the ratings, and press Evaluate. The verdict, the plan and the services appear here.' }));
  }

  const app = state.app;
  const wave = wavePlan(result.route, result.readiness, result.risk, state.mode);

  const summary = statGrid(
    stat({ label: 'Readiness', value: String(result.readiness), sub: 'out of 100' }),
    stat({ label: 'Course of action', value: result.route }),
    stat({ label: 'Target cloud', value: CLOUD_LABELS[result.cloud] }),
    stat({ label: 'Migration risk', value: result.risk, tone: riskTone(result.risk) }),
    stat({ label: 'Wave', value: wave.wave }),
  );

  const why = card(
    'Why',
    el(
      'ul',
      { class: 'list' },
      el('li', {}, el('strong', { text: `${result.route}. ` }), result.rationale),
      el('li', {}, el('strong', { text: `${CLOUD_LABELS[result.cloud]}. ` }), result.cloudRationale),
      el('li', {}, el('strong', { text: `${result.risk} risk. ` }), result.riskBecause.length > 0 ? `From ${result.riskBecause.join(', ')}.` : 'Nothing in the answers raises it.'),
      el('li', {}, el('strong', { text: `${wave.wave}. ` }), wave.rationale),
    ),
  );

  const services = card(
    `Services on ${CLOUD_LABELS[result.cloud]}`,
    el('p', { class: 'muted small', text: 'What covers each capability for this route. The first is the pick; the others are the near neighbours worth knowing about.' }),
    el(
      'div',
      { class: 'table-wrap' },
      el(
        'table',
        {},
        el('thead', {}, el('tr', {}, el('th', { text: 'Capability' }), el('th', { text: 'Use' }), el('th', { text: 'Also' }))),
        el(
          'tbody',
          {},
          ...result.services.map((s) =>
            el('tr', {}, el('td', { text: s.label }), el('td', {}, el('strong', { text: s.primary })), el('td', { class: 'muted small', text: s.related.join(', ') || '—' })),
          ),
        ),
      ),
    ),
  );

  const plan = card(
    'The plan',
    el(
      'ol',
      { class: 'plan-list' },
      ...result.plan
        .filter((line) => !line.trimStart().startsWith('•'))
        .map((step, index) => {
          const bullets: string[] = [];
          const at = result.plan.indexOf(step);
          for (let i = at + 1; i < result.plan.length; i += 1) {
            const line = result.plan[i] as string;
            if (!line.trimStart().startsWith('•')) break;
            bullets.push(line.replace(/^\s*•\s*/, ''));
          }
          return el(
            'li',
            {},
            el('span', { text: step.replace(/^\d+\)\s*/, '') }),
            bullets.length > 0 ? el('ul', { class: 'list small muted' }, ...bullets.map((b) => el('li', { text: b }))) : null,
            index < 0 ? null : null,
          );
        }),
    ),
  );

  const planText = (): string =>
    [
      `${app.name || 'Application'} — ${result.route} to ${CLOUD_LABELS[result.cloud]}`,
      `Readiness ${result.readiness}/100 · ${result.risk} risk · ${wave.wave}`,
      '',
      result.rationale,
      result.cloudRationale,
      '',
      ...result.plan,
      '',
      'Services:',
      ...result.services.map((s) => `  ${s.label}: ${[s.primary, ...s.related].join(', ')}`),
      '',
      'ArchToolKit produces drafts for review, not advice. Validate before you act on it.',
    ].join('\n');

  const actions = el(
    'div',
    { class: 'btn-row' },
    el('button', {
      class: 'btn btn-primary',
      text: 'Next application →',
      attrs: { title: 'Clear the form for the next one. This application is already in the portfolio.' },
      on: { click: () => startAnother(rerender) },
    }),
    el('button', {
      class: 'btn',
      text: 'Update the portfolio',
      attrs: { title: 'Save this application again, after changing an answer' },
      on: { click: () => void saveCurrent(rerender) },
    }),
    el('button', { class: 'btn', text: 'Open the portfolio', on: { click: () => showTab('portfolio') } }),
    el('button', {
      class: 'btn',
      text: 'Download record (JSON)',
      on: { click: () => downloadFile(`${app.name || 'application'}-migration.json`, exportJson([entryFor(app, catalog)]), 'application/json') },
    }),
    el('button', {
      class: 'btn',
      text: 'Copy the plan',
      on: {
        click: (event) => {
          const button = event.currentTarget as HTMLButtonElement;
          void navigator.clipboard?.writeText(planText()).then(
            () => {
              button.textContent = 'Copied';
              setTimeout(() => (button.textContent = 'Copy the plan'), 1500);
            },
            () => (button.textContent = 'Could not copy'),
          );
        },
      },
    }),
    el('button', { class: 'btn', text: '← Back to ratings', on: { click: () => showTab('ratings') } }),
  );

  return el('div', {}, summary, why, plan, services, actions);
}

/* -------------------------------------------------------------------------- *
 * Portfolio
 * -------------------------------------------------------------------------- */

function waveOf(entry: PortfolioEntry): Wave {
  return wavePlan(entry.evaluation.route, entry.evaluation.readiness, entry.evaluation.risk, state.mode).wave;
}

/** One labelled fact in a record. Blank answers are left out rather than shown empty. */
function fact(label: string, value: string | number | undefined | null): HTMLElement | null {
  const text = value === undefined || value === null ? '' : String(value).trim();
  if (text === '') return null;
  return el('div', { class: 'fact' }, el('span', { class: 'fact-label', text: label }), el('span', { class: 'fact-value', text }));
}

/**
 * Everything recorded for one application, opened out under its row.
 *
 * The portfolio is the compiled record of the work: each row is the whole
 * intake as it was answered, the verdict and why, the wave, and the plan —
 * not just the five columns that fit across the table. An application from a
 * CSV shows what the spreadsheet could answer and says plainly that its
 * ratings are still the defaults.
 */
function entryDetail(entry: PortfolioEntry, wave: Wave): HTMLElement {
  const app = entry.application;
  const result = entry.evaluation;
  const when = new Date(entry.evaluatedAt);
  const evaluatedAt = Number.isNaN(when.getTime()) ? entry.evaluatedAt : when.toLocaleString();

  const intake = el(
    'div',
    { class: 'fact-grid' },
    fact('Owner', app.owner),
    fact('Criticality', app.criticality),
    fact('Workload', app.workloadType),
    fact('RTO', `${app.rtoHours} h`),
    fact('RPO', `${app.rpoHours} h`),
    fact('Integrations', app.integrationCount),
    fact('Data size', `${app.dataSizeGb} GB`),
    fact('Enterprise standard', app.enterpriseStandardCloud ? CLOUD_LABELS[app.enterpriseStandardCloud] : ''),
    fact('Stack', app.primaryStack),
    fact('OS / runtime', app.osRuntime),
    fact('Database', app.database),
    fact('Hosting', app.hostingPlatform),
    fact('Integration types', app.integrationTypes),
    fact('Pattern', app.architecturePattern),
    fact('Vendor', app.vendor),
    fact('Identity', app.identity),
    fact('Compliance', app.compliance.join(', ')),
    fact('Constraints', GATES.filter((g) => app.gates[g.id as keyof typeof app.gates]).map((g) => g.label).join(', ')),
  );

  const ratings = el(
    'div',
    { class: 'fact-grid' },
    ...(Object.keys(WEIGHTS) as (keyof Ratings)[]).map((key) => fact(RATING_MEANING[key].label, `${app.ratings[key]} / 5`)),
  );

  const why = el(
    'ul',
    { class: 'list small' },
    el('li', {}, el('strong', { text: `${result.route}. ` }), result.rationale),
    el('li', {}, el('strong', { text: `${CLOUD_LABELS[result.cloud]}. ` }), result.cloudRationale),
    el('li', {}, el('strong', { text: `${result.risk} risk. ` }), result.riskBecause.length > 0 ? `From ${result.riskBecause.join(', ')}.` : 'Nothing in the answers raises it.'),
    el('li', {}, el('strong', { text: `${wave}. ` }), WAVE_MEANING[wave]),
  );

  const services = el('div', { class: 'fact-grid' }, ...result.services.map((s) => fact(s.label, [s.primary, ...s.related].join(', '))));

  return el(
    'div',
    { class: 'entry-detail' },
    entry.draft
      ? el('div', { class: 'section-note', text: 'Imported from a spreadsheet: the six ratings and the hard constraints are still at their defaults. Open it to answer them.' })
      : null,
    el('div', { class: 'detail-block' }, el('h4', { text: 'Intake' }), intake),
    el('div', { class: 'detail-block' }, el('h4', { text: 'Ratings' }), ratings),
    el('div', { class: 'detail-block' }, el('h4', { text: 'Verdict' }), why),
    result.services.length > 0 ? el('div', { class: 'detail-block' }, el('h4', { text: `Services on ${CLOUD_LABELS[result.cloud]}` }), services) : null,
    app.notes ? el('div', { class: 'detail-block' }, el('h4', { text: 'Notes' }), el('p', { class: 'small', text: app.notes })) : null,
    el('div', { class: 'small muted', text: `Evaluated ${evaluatedAt}${entry.draft ? ' · draft' : ''}` }),
  );
}

function visibleEntries(): PortfolioEntry[] {
  return state.entries.filter((entry) => {
    if (state.filterCloud && entry.evaluation.cloud !== state.filterCloud) return false;
    if (state.filterRoute && entry.evaluation.route !== state.filterRoute) return false;
    if (state.filterWave && waveOf(entry) !== state.filterWave) return false;
    return true;
  });
}

async function persist(rerender: () => void): Promise<void> {
  const ok = await savePortfolio(state.entries);
  if (!ok) {
    state.notes = [
      {
        severity: 'warning',
        code: 'migration.portfolio.not-saved',
        message: 'This browser would not keep the portfolio, so it will be gone when the page closes. Export it if you need it.',
        source: 'portfolio',
      },
    ];
  }
  rerender();
}

async function saveCurrent(rerender: () => void): Promise<void> {
  if (!state.app.name.trim()) {
    state.notes = [{ severity: 'error', code: 'migration.no-name', message: 'Give the application a name before saving it to the portfolio.', source: 'portfolio' }];
    rerender();
    return;
  }
  state.entries = upsert(state.entries, entryFor(state.app, catalog));
  state.notes = [{ severity: 'info', code: 'migration.saved', message: `"${state.app.name}" saved to the portfolio.`, source: 'portfolio' }];
  await persist(rerender);
}

/**
 * Evaluate the application and put it in the portfolio: one action, because
 * they are one intention. Going through a list of applications means doing
 * this once per application, and an evaluation that had to be saved separately
 * afterwards is an evaluation someone will lose.
 *
 * A name is what a portfolio row is identified by, so that is the one thing
 * this insists on.
 */
function runEvaluation(rerender: () => void): void {
  const named = state.app.name.trim();
  if (!named) {
    state.notes = [
      {
        severity: 'error',
        code: 'migration.no-name',
        message: 'Give the application a name first — it is what its row in the portfolio is called.',
        source: 'portfolio',
      },
    ];
    rerender();
    showTab('intake');
    document.getElementById('app-name')?.focus();
    return;
  }

  state.evaluation = evaluate(state.app, catalog);
  const before = state.entries.length;
  state.entries = upsert(state.entries, entryFor(state.app, catalog));
  const added = state.entries.length > before;
  state.notes = [
    {
      severity: 'info',
      code: 'migration.saved',
      message: `"${named}" evaluated and ${added ? 'added to' : 'updated in'} the portfolio — ${state.entries.length} application${state.entries.length === 1 ? '' : 's'} so far.`,
      source: 'portfolio',
    },
  ];
  void persist(rerender);
  showTab('results');
}

/** Empty the form for the next application, keeping the portfolio. */
function startAnother(rerender: () => void): void {
  state.app = { ...EMPTY_APPLICATION, gates: { ...NO_GATES }, ratings: { ...DEFAULT_RATINGS } };
  state.evaluation = null;
  state.notes = [];
  rerender();
  showTab('intake');
  document.getElementById('app-name')?.focus();
}

function portfolioSection(rerender: () => void): HTMLElement {
  const rows = visibleEntries();
  const counts = countWaves(state.entries.map(waveOf));

  const modeSelect = select<WaveMode>(
    WAVE_MODES.map((m) => ({ value: m.id, label: m.label })),
    state.mode,
  );
  modeSelect.addEventListener('change', () => {
    state.mode = modeSelect.value as WaveMode;
    rerender();
  });

  const cloudFilter = select<Cloud | ''>([{ value: '', label: 'Every cloud' }, ...CLOUDS.map((c) => ({ value: c, label: CLOUD_LABELS[c] }))], state.filterCloud);
  cloudFilter.addEventListener('change', () => {
    state.filterCloud = cloudFilter.value as Cloud | '';
    rerender();
  });

  const routeFilter = select(
    [{ value: '', label: 'Every route' }, ...['Rehost', 'Replatform', 'Refactor', 'Repurchase', 'Retain', 'Retire'].map((r) => ({ value: r, label: r }))],
    state.filterRoute,
  );
  routeFilter.addEventListener('change', () => {
    state.filterRoute = routeFilter.value;
    rerender();
  });

  const waveFilter = select([{ value: '', label: 'Every wave' }, ...['Wave 1', 'Wave 2', 'Wave 3', 'Blocked'].map((w) => ({ value: w, label: w }))], state.filterWave);
  waveFilter.addEventListener('change', () => {
    state.filterWave = waveFilter.value;
    rerender();
  });

  const controls = card(
    'Wave planning',
    el(
      'div',
      { class: 'field-grid' },
      field('Planning mode', modeSelect, WAVE_MODES.find((m) => m.id === state.mode)?.description),
      field('Show', el('div', { class: 'filter-row' }, cloudFilter, routeFilter, waveFilter), 'Filters the table below; the counts are for the whole portfolio.'),
    ),
    statGrid(
      stat({ label: 'Applications', value: String(counts.total) }),
      stat({ label: 'Wave 1', value: String(counts.wave1), sub: 'quick wins' }),
      stat({ label: 'Wave 2', value: String(counts.wave2), sub: 'core' }),
      stat({ label: 'Wave 3', value: String(counts.wave3), sub: 'long tail' }),
      stat({ label: 'Blocked', value: String(counts.blocked), tone: counts.blocked > 0 ? 'warn' : 'neutral' }),
    ),
    el('div', { class: 'section-note', text: `Wave 0 comes before all of them. ${WAVE_MEANING['Wave 0']}` }),
  );

  const body = el('tbody', {});
  for (const entry of rows) {
    const wave = waveOf(entry);
    const open = state.expanded.has(entry.id);
    const toggle = el('button', {
      class: 'btn-link row-toggle',
      text: `${open ? '▾' : '▸'} ${entry.application.name}`,
      attrs: { type: 'button', 'aria-expanded': open ? 'true' : 'false', title: 'Show everything recorded for this application' },
      on: {
        click: () => {
          if (open) state.expanded.delete(entry.id);
          else state.expanded.add(entry.id);
          rerender();
        },
      },
    });
    append(
      body,
      el(
        'tr',
        {},
        el('td', {}, toggle, entry.draft ? el('span', { class: 'badge badge-community', text: 'draft' }) : null),
        el('td', { class: 'muted small', text: entry.application.owner || '—' }),
        el('td', { text: entry.application.criticality }),
        el('td', { text: entry.evaluation.route }),
        el('td', { text: CLOUD_LABELS[entry.evaluation.cloud] }),
        el('td', { text: String(entry.evaluation.readiness) }),
        el('td', {}, el('span', { class: `tag tag-${riskTone(entry.evaluation.risk)}`, text: entry.evaluation.risk })),
        el('td', { text: wave }),
        el(
          'td',
          { class: 'row-actions' },
          el('button', {
            class: 'btn btn-small',
            text: 'Open',
            on: {
              click: () => {
                state.app = entry.application;
                state.evaluation = entry.evaluation;
                rerender();
                showTab('intake');
              },
            },
          }),
          el('button', {
            class: 'btn btn-small',
            text: 'Remove',
            on: {
              click: () => {
                state.expanded.delete(entry.id);
                state.entries = removeEntry(state.entries, entry.id);
                void persist(rerender);
              },
            },
          }),
        ),
      ),
    );
    if (open) append(body, el('tr', { class: 'detail-row' }, el('td', { attrs: { colspan: '9' } }, entryDetail(entry, wave))));
  }

  const table = el(
    'div',
    { class: 'table-wrap' },
    el(
      'table',
      {},
      el(
        'thead',
        {},
        el(
          'tr',
          {},
          el('th', { text: 'Application' }),
          el('th', { text: 'Owner' }),
          el('th', { text: 'Criticality' }),
          el('th', { text: 'Route' }),
          el('th', { text: 'Cloud' }),
          el('th', { text: 'Readiness' }),
          el('th', { text: 'Risk' }),
          el('th', { text: 'Wave' }),
          el('th', { text: '' }),
        ),
      ),
      body,
    ),
  );

  const empty = el('p', {
    class: 'empty',
    text:
      state.entries.length === 0
        ? 'Nothing evaluated yet. Evaluate an application, or import a CSV inventory below to start a backlog.'
        : 'No application matches those filters.',
  });

  const picker = el('input', { attrs: { type: 'file', accept: '.csv,.json,text/csv,application/json', hidden: 'hidden', 'data-control': 'portfolio-import' } }) as HTMLInputElement;
  picker.addEventListener('change', () => {
    const file = picker.files?.[0];
    picker.value = '';
    if (!file) return;
    void readFileAsText(file).then((text) => {
      const result = /\.csv$/i.test(file.name) ? importCsv(text, catalog) : importJson(text, catalog);
      state.entries = merge(state.entries, result.entries);
      state.notes = [...result.findings];
      void persist(rerender);
    });
  });

  const files = card(
    'Files',
    el(
      'div',
      { class: 'btn-row' },
      el('button', { class: 'btn', text: 'Import CSV or JSON…', on: { click: () => picker.click() } }),
      el('button', {
        class: 'btn',
        text: 'Export CSV',
        on: { click: () => downloadFile('migration-portfolio.csv', exportCsv(state.entries, (e) => waveOf(e)), 'text/csv') },
      }),
      el('button', { class: 'btn', text: 'Export JSON', on: { click: () => downloadFile('migration-portfolio.json', exportJson(state.entries), 'application/json') } }),
      el('button', {
        class: 'btn',
        text: 'Re-evaluate all',
        on: {
          click: () => {
            state.entries = reevaluate(state.entries, catalog);
            state.notes = [{ severity: 'info', code: 'migration.reevaluated', message: `${state.entries.length} application(s) evaluated again with the current rules.`, source: 'portfolio' }];
            void persist(rerender);
          },
        },
      }),
      el('button', {
        class: 'btn btn-danger',
        text: 'Empty the portfolio',
        on: {
          click: () => {
            state.entries = [];
            state.notes = [];
            void clearPortfolio().then(() => rerender());
          },
        },
      }),
      picker,
    ),
    el('div', { class: 'section-note' }, el('strong', { text: 'CSV columns. ' }), el('code', { text: CSV_COLUMNS.join(', ') }), el('div', {
      class: 'small',
      text: 'Separate compliance scopes with semicolons. An imported row is a draft: its ratings are the defaults until you open it and answer them.',
    })),
  );

  return el(
    'div',
    {},
    controls,
    card('Applications', rows.length > 0 ? table : empty),
    files,
    state.notes.length > 0 ? card('Notes', findingsList(state.notes, 'Nothing to report.')) : null,
  );
}

/* -------------------------------------------------------------------------- *
 * How it works
 * -------------------------------------------------------------------------- */

function helpSection(): HTMLElement {
  return el(
    'div',
    {},
    card(
      'How the verdict is reached',
      el('p', { class: 'muted' }, 'In this order, and every step says what it based itself on:'),
      el(
        'ol',
        { class: 'list' },
        el('li', {}, el('strong', { text: 'The hard constraints first. ' }), 'Obsolete means retire; a vendor SaaS replacement with nothing keeping it on-premises means repurchase; a policy, hardware or mainframe dependency means retain. None of these consult the score.'),
        el('li', {}, el('strong', { text: 'Then the readiness score. ' }), '80 or more refactors, 60 replatforms, 40 rehosts, 20 retains, below that retires. Six factors, weighted, all reading the same way: 5 is the best case for a move.'),
        el('li', {}, el('strong', { text: 'Then the cloud. ' }), 'An enterprise standard wins outright. Otherwise regulated or sovereign data, then an Oracle estate, then a Microsoft estate, then analytics and AI, and AWS when nothing else speaks up.'),
        el('li', {}, el('strong', { text: 'Then the risk band, ' }), 'from criticality, RTO, RPO, integration count and compliance scope. It changes the wave, not the route.'),
        el('li', {}, el('strong', { text: 'Then the plan and the services ' }), 'for that route on that cloud.'),
      ),
    ),
    card(
      'The seven routes',
      el(
        'ul',
        { class: 'list' },
        el('li', {}, el('strong', { text: 'Rehost. ' }), 'Lift and shift the VMs, keep the stack, harden it afterwards.'),
        el('li', {}, el('strong', { text: 'Replatform. ' }), 'Move onto managed services — database, queue, cache — with little code change.'),
        el('li', {}, el('strong', { text: 'Refactor. ' }), 'Modernise: containers or a managed platform, CI/CD, carve the monolith up.'),
        el('li', {}, el('strong', { text: 'Repurchase. ' }), 'Replace it with SaaS and decommission the original.'),
        el('li', {}, el('strong', { text: 'Retain. ' }), 'Leave it where it is, reduce its risk, reassess on a cadence.'),
        el('li', {}, el('strong', { text: 'Retire. ' }), 'Turn it off, after retention and legal hold are settled.'),
      ),
    ),
    card(
      'The waves',
      el('ul', { class: 'list' }, ...Object.entries(WAVE_MEANING).map(([wave, meaning]) => el('li', {}, el('strong', { text: `${wave}. ` }), meaning))),
    ),
    el('div', {
      class: 'section-note',
      text: 'All of it is decision support: a weighted reading of the answers given here, to be checked against discovery, licensing, contracts and the people accountable for the application. Nothing here is advice.',
    }),
  );
}

/* -------------------------------------------------------------------------- *
 * The page
 * -------------------------------------------------------------------------- */

const TABS = [
  { id: 'intake', label: 'Intake' },
  { id: 'ratings', label: 'Ratings' },
  { id: 'results', label: 'Results' },
  { id: 'portfolio', label: 'Portfolio' },
  { id: 'help', label: 'How it works' },
] as const;

type TabId = (typeof TABS)[number]['id'];

let active: TabId = 'intake';

function showTab(id: TabId): void {
  active = id;
  for (const tab of Array.from(document.querySelectorAll<HTMLElement>('.tab'))) {
    tab.classList.toggle('active', tab.dataset['tab'] === id);
  }
  for (const section of Array.from(document.querySelectorAll<HTMLElement>('.section'))) {
    section.classList.toggle('active', section.id === `sec-${id}`);
  }
  if (globalThis.location) {
    const url = new URL(globalThis.location.href);
    url.hash = id;
    globalThis.history?.replaceState(null, '', url.toString());
  }
}

function intakeAsJson(): Json {
  return JSON.parse(JSON.stringify(state.app)) as Json;
}

export function mountMigrationPage(root: HTMLElement): void {
  const render = (): void => {
    const strip = el('div', { class: 'tabs' });
    for (const tab of TABS) {
      append(
        strip,
        el('div', {
          class: `tab${tab.id === active ? ' active' : ''}`,
          text: tab.label,
          dataset: { tab: tab.id },
          attrs: { role: 'button', tabindex: '0' },
          on: {
            click: () => showTab(tab.id),
            keydown: (event) => {
              if ((event as KeyboardEvent).key === 'Enter' || (event as KeyboardEvent).key === ' ') showTab(tab.id);
            },
          },
        }),
      );
    }

    const bar = fileBar({
      noun: 'application intake',
      fileName: () => state.app.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'application',
      save: () => intakeAsJson(),
      header: () => ['ArchToolKit — application migration intake', 'Ratings and constraints included. No credentials are written here.'],
      load: (value, name) => {
        const parsed = importJson(JSON.stringify(value), catalog);
        const first = parsed.entries[0];
        if (!first) throw new Error(parsed.findings[0]?.message ?? 'That file has no application in it.');
        state.app = first.application;
        state.evaluation = null;
        render();
        showTab('intake');
        return `Loaded ${first.application.name} from ${name}.`;
      },
      clear: () => {
        state.app = { ...EMPTY_APPLICATION, gates: { ...NO_GATES }, ratings: { ...DEFAULT_RATINGS } };
        state.evaluation = null;
        state.notes = [];
        render();
        showTab('intake');
      },
    });

    const sections = el(
      'div',
      {},
      el('div', { class: `section${active === 'intake' ? ' active' : ''}`, id: 'sec-intake' }, intakeSection(render)),
      el('div', { class: `section${active === 'ratings' ? ' active' : ''}`, id: 'sec-ratings' }, ratingsSection(render)),
      el('div', { class: `section${active === 'results' ? ' active' : ''}`, id: 'sec-results' }, resultsSection(render)),
      el('div', { class: `section${active === 'portfolio' ? ' active' : ''}`, id: 'sec-portfolio' }, portfolioSection(render)),
      el('div', { class: `section${active === 'help' ? ' active' : ''}`, id: 'sec-help' }, helpSection()),
    );

    clear(root);
    append(root, bar, strip, sections);
    if (state.notes.length > 0 && active !== 'portfolio') {
      append(root, card('Notes', findingsList(state.notes, 'Nothing to report.')));
    }
  };

  render();

  // The portfolio is held in this browser; read it once the page is up.
  void loadPortfolio().then((entries) => {
    if (entries.length > 0) {
      state.entries = entries;
      render();
    }
    const wanted = (globalThis.location?.hash ?? '').replace('#', '');
    if (TABS.some((t) => t.id === wanted)) showTab(wanted as TabId);
    else showTab(active);
  });
}

const root = typeof document === 'undefined' ? null : document.getElementById('migration-root');
if (root) mountMigrationPage(root);
