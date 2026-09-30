/**
 * Application Migration: one application at a time, in three stages.
 *
 *   Stage 1  Know the application   (the app list, then five steps)
 *   Stage 2  Choose the cloud
 *   Stage 3  The runbook
 *
 * It looks like the original Multi-Cloud Decision & Onboarding Wizard: one
 * dark panel with its own header (the application picked on the right), a
 * step card with upper-case labels and a hint under each question, a "Step
 * n of 5" badge, and Back / Next at the foot. Stage 1 is four steps of
 * questions, three sections each, and a fifth that is the assessment. Every
 * answer is the user's; the page only checks. Applications are kept in this
 * browser (the `apps` store) and saved as they are typed.
 */

import { el, clear, append } from './dom.ts';
import {
  BUSY_HOURS,
  CARDS,
  CRITICALITY,
  DR_TODAY,
  ENVIRONMENTS,
  GPU,
  HOSTING_PLATFORMS,
  NON_PROD_SCALE,
  RPO,
  RTO,
  SCREENS,
  SEASONALITY,
  SOURCE_ENVIRONMENTS,
  UPTIME,
  VENDORS,
  continuityProblems,
  continuityProgress,
  continuitySignals,
  displayName,
  hostingLabel,
  identityProblems,
  identityProgress,
  identitySignals,
  loadProblems,
  loadProgress,
  loadSignals,
  newApp,
  screenBuilt,
  sourceLabel,
  vendorLabel,
  type AppRecord,
  type CardId,
  type Option,
  type ScreenId,
} from '../appmig/model.ts';
import { deleteApp, listApps, saveApp } from '../appmig/store.ts';

const root = document.getElementById('migration-root');

let apps: AppRecord[] = [];
let openId: string | null = null;
let saveTimer: ReturnType<typeof setTimeout> | undefined;
let statusLine: HTMLElement | null = null;

function when(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function current(): AppRecord | undefined {
  return apps.find((a) => a.id === openId);
}

/** The wizard's own header: title and what is being worked on at the left, the application at the right. */
function header(app?: AppRecord): HTMLElement {
  const picker = el(
    'select',
    { attrs: { 'aria-label': 'Application' } },
    el('option', { text: 'All applications', attrs: { value: '' } }),
    ...apps.map((a) => el('option', { text: displayName(a), attrs: { value: a.id } })),
  );
  picker.value = app?.id ?? '';
  picker.addEventListener('change', () => {
    location.hash = picker.value ? `app=${picker.value}` : '';
  });
  return el(
    'div',
    { class: 'amw-header' },
    el(
      'div',
      {},
      el('h2', {}, el('span', { class: 'amw-orb' }), 'Application Migration'),
      el('p', {}, app ? 'Stage 1 · Know the application · assessing ' : 'Stage 1 · Know the application', app ? el('strong', { text: displayName(app) }) : null, app ? '.' : null),
    ),
    el('label', { class: 'amw-picker' }, el('span', { text: 'Application:' }), picker),
  );
}

// --- The application list ---------------------------------------------------

function progressOf(app: AppRecord): string {
  const parts = [identityProgress(app.identity), continuityProgress(app.continuity), loadProgress(app.load)];
  return `${parts.reduce((n, p) => n + p.answered, 0)} of ${parts.reduce((n, p) => n + p.of, 0)}`;
}

function renderList(): void {
  if (!root) return;
  clear(root);
  const add = el('button', { class: 'amw-btn amw-next', text: '+ Add application', attrs: { type: 'button' }, on: { click: () => void addApp() } });
  const body =
    apps.length === 0
      ? el('p', { class: 'amw-muted', text: 'No applications yet. Add the first one: everything about it is answered step by step, and it is kept in this browser.' })
      : el(
          'table',
          { class: 'amw-table' },
          el('thead', {}, el('tr', {}, ...['Application', 'Business owner', 'Vendor', 'Source environment', 'Answered', 'Last changed', ''].map((h) => el('th', { text: h })))),
          el(
            'tbody',
            {},
            ...apps.map((app) =>
              el(
                'tr',
                {},
                el('td', {}, el('a', { text: displayName(app), attrs: { href: `#app=${app.id}` } })),
                el('td', { text: app.identity.businessOwner }),
                el('td', { text: vendorLabel(app.identity) }),
                el('td', { text: sourceLabel(app.identity) }),
                el('td', { text: progressOf(app) }),
                el('td', { class: 'amw-muted', text: when(app.updated) }),
                el('td', { class: 'amw-row-actions' }, el('a', { class: 'amw-btn amw-back', text: 'Open', attrs: { href: `#app=${app.id}` } }), deleteButton(app)),
              ),
            ),
          ),
        );
  append(
    root,
    el(
      'div',
      { class: 'amw' },
      header(),
      el(
        'section',
        { class: 'amw-card' },
        el('div', { class: 'amw-card-head' }, el('div', {}, el('h3', { text: 'Applications' }), el('p', { class: 'amw-sub', text: 'Every application to be moved, one profile each' })), add),
        body,
      ),
    ),
  );
}

/** Delete asks on the button itself: the first press arms it, the second deletes. */
function deleteButton(app: AppRecord): HTMLButtonElement {
  const button = el('button', { class: 'amw-btn amw-danger', text: 'Delete', attrs: { type: 'button' } });
  let armed: ReturnType<typeof setTimeout> | undefined;
  button.addEventListener('click', () => {
    if (!armed) {
      button.textContent = 'Click again to delete';
      armed = setTimeout(() => {
        armed = undefined;
        button.textContent = 'Delete';
      }, 4000);
      return;
    }
    clearTimeout(armed);
    void deleteApp(app.id).then(async () => {
      apps = await listApps();
      renderList();
    });
  });
  return button;
}

async function addApp(): Promise<void> {
  const app = newApp(crypto.randomUUID(), new Date().toISOString());
  if (!(await saveApp(app))) {
    alert('This browser will not store the application (private window or storage blocked), so it cannot be kept.');
    return;
  }
  apps = await listApps();
  location.hash = `app=${app.id}`;
}

// --- Fields -----------------------------------------------------------------

type Answers = Record<string, string | string[]>;

function changed(): void {
  const app = current();
  if (!app) return;
  app.updated = new Date().toISOString();
  if (statusLine) statusLine.textContent = 'Saving…';
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = undefined;
    void saveApp(app).then((ok) => {
      if (statusLine) statusLine.textContent = ok ? `Saved ${when(app.updated)}` : 'Not saved: this browser refused to store it.';
    });
  }, 400);
}

function fieldBox(id: string, label: string, control: HTMLElement, hint?: string, opts: { required?: boolean; wide?: boolean } = {}): HTMLElement {
  return el(
    'div',
    { class: `amw-field${opts.wide ? ' amw-wide' : ''}` },
    el('label', { attrs: { for: id } }, label, opts.required ? el('span', { class: 'amw-req', text: ' *' }) : null),
    control,
    hint ? el('div', { class: 'amw-hint', text: hint }) : null,
  );
}

function textField(obj: Answers, key: string, label: string, hint?: string, opts: { required?: boolean; area?: boolean; placeholder?: string; numeric?: boolean } = {}): HTMLElement {
  const id = `f-${key}`;
  const input = opts.area
    ? el('textarea', { id, attrs: { rows: 2, placeholder: opts.placeholder } })
    : el('input', { id, attrs: { type: 'text', inputmode: opts.numeric ? 'numeric' : null, placeholder: opts.placeholder, autocomplete: 'off' } });
  input.value = String(obj[key] ?? '');
  input.addEventListener('input', () => {
    obj[key] = input.value;
    changed();
  });
  return fieldBox(id, label, input, hint, { required: opts.required, wide: opts.area });
}

/** A closed set, with its "Other" box shown only when Other is picked. */
function selectField(obj: Answers, key: string, label: string, options: readonly Option[], hint?: string, other?: { key: string; label: string }): HTMLElement[] {
  const id = `f-${key}`;
  const select = el('select', { id }, el('option', { text: 'Select…', attrs: { value: '' } }), ...options.map((o) => el('option', { text: o.label, attrs: { value: o.value } })));
  select.value = String(obj[key] ?? '');
  const fields: HTMLElement[] = [fieldBox(id, label, select, hint)];
  let otherField: HTMLElement | null = null;
  if (other) {
    otherField = textField(obj, other.key, other.label, 'As it should appear in the plan.', { required: true });
    otherField.hidden = obj[key] !== 'Other';
    fields.push(otherField);
  }
  select.addEventListener('change', () => {
    obj[key] = select.value;
    if (otherField) otherField.hidden = select.value !== 'Other';
    changed();
  });
  return fields;
}

/** Ticks for a list of values; `onChange` lets a section show or hide what depends on them. */
function checkboxField(obj: Answers, key: string, label: string, options: readonly Option[], hint: string, onChange?: () => void): HTMLElement {
  const chosen = new Set(Array.isArray(obj[key]) ? (obj[key] as string[]) : []);
  const boxes = el(
    'div',
    { class: 'amw-checks' },
    ...options.map((o) => {
      const box = el('input', { attrs: { type: 'checkbox', value: o.value, checked: chosen.has(o.value) } });
      box.addEventListener('change', () => {
        if (box.checked) chosen.add(o.value);
        else chosen.delete(o.value);
        obj[key] = options.map((x) => x.value).filter((v) => chosen.has(v));
        changed();
        onChange?.();
      });
      return el('label', {}, box, ` ${o.label}`);
    }),
  );
  return el('div', { class: 'amw-field' }, el('span', { class: 'amw-label', text: label }), boxes, el('div', { class: 'amw-hint', text: hint }));
}

/** A field two columns wide. */
function wide2(field: HTMLElement): HTMLElement {
  field.classList.add('amw-span2');
  return field;
}

// --- The sections -------------------------------------------------------------

const SECTIONS: Partial<Record<CardId, (app: AppRecord) => HTMLElement[]>> = {
  identity: (app) => {
    const i = app.identity as unknown as Answers;
    return [
      wide2(textField(i, 'name', 'Application name', 'Short label so you recognise it in reviews.', { required: true, placeholder: 'e.g. Case Management System' })),
      ...selectField(i, 'vendor', 'Vendor', VENDORS, 'Who makes it. Custom Built if it is your own code.', { key: 'vendorOther', label: 'Vendor name' }),
      textField(i, 'businessUnit', 'Business unit', 'The part of the organisation it serves.'),
      textField(i, 'businessOwner', 'Business owner / team', 'Who signs off on the move.'),
      textField(i, 'technicalOwner', 'Technical owner', 'Who knows how it is built and run.'),
      ...selectField(i, 'sourceEnvironment', 'Source environment', SOURCE_ENVIRONMENTS, 'Where it runs today.'),
      ...selectField(i, 'hostingPlatform', 'Hosting platform', HOSTING_PLATFORMS, 'What it runs on today.', { key: 'hostingOther', label: 'Hosting platform name' }),
      el(
        'div',
        { class: 'amw-pair' },
        textField(i, 'description', 'Short description', undefined, { area: true, placeholder: 'What does it do? Who uses it? What would stop if it went down?' }),
        textField(i, 'notes', 'Notes', undefined, { area: true, placeholder: 'Key constraints, special requirements, known pain points' }),
      ),
    ];
  },
  continuity: (app) => {
    const c = app.continuity as unknown as Answers;
    const scale = selectField(c, 'nonProdScale', 'Non-prod scale vs prod', NON_PROD_SCALE, 'How big Dev, Test and Stage are next to Prod.');
    const showScale = () => {
      const nonProd = (c['environments'] as string[]).some((e) => e !== 'prod' && e !== 'dr');
      for (const f of scale) f.hidden = !nonProd;
    };
    const out = [
      ...selectField(c, 'criticality', 'Business criticality', CRITICALITY, 'How much the business depends on it.'),
      ...selectField(c, 'uptime', 'Uptime target', UPTIME, 'The availability it has to keep.'),
      ...selectField(c, 'drToday', 'DR today', DR_TODAY, 'What protects it now, before the move.'),
      ...selectField(c, 'rto', 'RTO', RTO, 'How long it can be down after a failure.'),
      ...selectField(c, 'rpo', 'RPO', RPO, 'How much recent data it can lose.'),
      checkboxField(c, 'environments', 'Environments in scope', ENVIRONMENTS, 'Which environments this move covers.', showScale),
      ...scale,
    ];
    showScale();
    return out;
  },
  load: (app) => {
    const l = app.load as unknown as Answers;
    return [
      textField(l, 'peakUsers', 'Peak concurrent users', 'At the busiest time.', { numeric: true, placeholder: 'e.g. 5000' }),
      textField(l, 'peakRps', 'Peak requests / second', 'Pushes toward autoscaling or reserved capacity.', { numeric: true, placeholder: 'e.g. 200' }),
      ...selectField(l, 'busyHours', 'When it is busy', BUSY_HOURS, 'Decides what can be scheduled off.'),
      ...selectField(l, 'seasonality', 'Seasonal peaks', SEASONALITY, 'Size for the peak, and avoid cutting over during one.'),
      ...selectField(l, 'gpu', 'GPU', GPU, 'Needs GPU capacity in the target region?'),
    ];
  },
};

// --- Steps ------------------------------------------------------------------

function goTo(screen: ScreenId): void {
  location.hash = `app=${openId}&screen=${screen}`;
}

/** The nearest built step before or after this one. */
function neighbour(at: number, step: 1 | -1): (typeof SCREENS)[number] | undefined {
  for (let i = at + step; i >= 0 && i < SCREENS.length; i += step) {
    const s = SCREENS[i];
    if (s && screenBuilt(s)) return s;
  }
  return undefined;
}

function stepDots(active: ScreenId): HTMLElement {
  return el(
    'div',
    { class: 'amw-steps', attrs: { role: 'list', 'aria-label': 'Steps' } },
    ...SCREENS.map((s, i) => {
      const built = screenBuilt(s);
      return el('button', {
        class: `amw-step${s.id === active ? ' is-active' : ''}`,
        text: `${i + 1} ${s.title}`,
        attrs: { type: 'button', disabled: !built, title: built ? s.title : `${s.title}: built next`, 'aria-current': s.id === active ? 'step' : null },
        on: { click: () => goTo(s.id) },
      });
    }),
  );
}

const STEP_NOTES: Record<ScreenId, string> = {
  application: 'Who owns it, how critical it is, and how much load it carries.',
  build: 'Its architecture, servers and data.',
  links: 'What it connects to, the rules it must follow, and its network.',
  today: 'What blocks a move, how ready it is, and how it is run.',
  assessment: 'What your answers say. You choose the route here.',
};

function renderScreen(app: AppRecord, screenId: ScreenId): void {
  if (!root) return;
  clear(root);
  const at = SCREENS.findIndex((s) => s.id === screenId);
  const screen = SCREENS[at];
  if (!screen) return;
  const prev = neighbour(at, -1);
  const next = neighbour(at, 1);
  statusLine = el('span', { class: 'amw-status', text: `Saved ${when(app.updated)}` });

  const body =
    screen.id === 'assessment'
      ? assessmentBody(app)
      : screen.cards.map((cardId) =>
          el(
            'div',
            { class: 'amw-section' },
            el('h4', { text: CARDS.find((c) => c.id === cardId)?.title ?? cardId }),
            el('div', { class: 'amw-grid' }, ...(SECTIONS[cardId]?.(app) ?? [])),
          ),
        );

  append(
    root,
    el(
      'div',
      { class: 'amw' },
      header(app),
      stepDots(screenId),
      el(
        'section',
        { class: 'amw-card' },
        el(
          'div',
          { class: 'amw-card-head' },
          el('div', {}, el('h3', { text: `Step ${at + 1} · ${screen.title}` }), el('p', { class: 'amw-sub', text: STEP_NOTES[screen.id] })),
          el('span', { class: 'amw-pill', text: `Step ${at + 1} of ${SCREENS.length}` }),
        ),
        ...body,
        el(
          'div',
          { class: 'amw-foot' },
          statusLine,
          el(
            'div',
            { class: 'amw-foot-buttons' },
            prev
              ? el('button', { class: 'amw-btn amw-back', text: '← Back', attrs: { type: 'button' }, on: { click: () => goTo(prev.id) } })
              : el('a', { class: 'amw-btn amw-back', text: '← All applications', attrs: { href: '#' } }),
            next ? el('button', { class: 'amw-btn amw-next', text: 'Next →', attrs: { type: 'button', title: next.title }, on: { click: () => goTo(next.id) } }) : null,
          ),
        ),
      ),
    ),
  );
}

// --- The assessment (step 5) -------------------------------------------------

function assessmentBody(app: AppRecord): HTMLElement[] {
  const i = app.identity;
  const c = app.continuity;
  const label = (list: readonly Option[], v: string) => list.find((o) => o.value === v)?.label ?? '';
  const pills = [
    ['Vendor', vendorLabel(i)],
    ['Source', sourceLabel(i)],
    ['Hosting', hostingLabel(i)],
    ['Criticality', label(CRITICALITY, c.criticality).split(' – ')[0] ?? ''],
    ['Uptime', c.uptime ? `${c.uptime}%` : ''],
    ['RTO', label(RTO, c.rto)],
    ['RPO', label(RPO, c.rpo)],
  ].filter(([, v]) => v);
  const rows: [string, { answered: number; of: number }, string[]][] = [
    ['Identity', identityProgress(i), identityProblems(app, apps).map((p) => p.message)],
    ['Criticality and continuity', continuityProgress(c), continuityProblems(c)],
    ['Users and load', loadProgress(app.load), loadProblems(app.load)],
  ];
  const signals = [...identitySignals(i), ...continuitySignals(c), ...loadSignals(app.load)];
  return [
    el('div', { class: 'amw-pills' }, ...pills.map(([k, v]) => el('span', { class: 'amw-pill', text: `${k}: ${v}` }))),
    el(
      'div',
      { class: 'amw-section' },
      el('h4', { text: 'What is answered' }),
      el(
        'table',
        { class: 'amw-table' },
        el('thead', {}, el('tr', {}, el('th', { text: 'Section' }), el('th', { text: 'Answered' }), el('th', { text: 'Still needed' }))),
        el(
          'tbody',
          {},
          ...rows.map(([name, p, problems]) =>
            el('tr', {}, el('td', { text: name }), el('td', { text: `${p.answered} of ${p.of}` }), el('td', { class: problems.length ? 'amw-req' : 'amw-muted', text: problems.join(' ') || 'Nothing' })),
          ),
        ),
      ),
    ),
    el(
      'div',
      { class: 'amw-section' },
      el('h4', { text: 'What the answers say' }),
      signals.length > 0 ? el('ul', { class: 'amw-list' }, ...signals.map((s) => el('li', { text: s }))) : el('p', { class: 'amw-muted', text: 'Nothing yet.' }),
    ),
    el(
      'div',
      { class: 'amw-section' },
      el('h4', { text: 'Still to come' }),
      el('p', { class: 'amw-muted', text: 'The readiness score, the hard gates, the risk and the reasons for each route appear here as steps 2 to 4 are built, and you choose the route here.' }),
    ),
  ];
}

// --- Routing ----------------------------------------------------------------

async function route(): Promise<void> {
  // An edit still waiting for its save is saved before the page moves on.
  const pending = saveTimer !== undefined ? current() : undefined;
  clearTimeout(saveTimer);
  saveTimer = undefined;
  if (pending) await saveApp(pending);
  const match = /^#app=([^&]+)(?:&screen=([a-z]+))?$/.exec(location.hash);
  apps = await listApps();
  const app = match ? apps.find((a) => a.id === match[1]) : undefined;
  openId = app?.id ?? null;
  const asked = SCREENS.find((s) => s.id === match?.[2]);
  const screen = asked && screenBuilt(asked) ? asked.id : 'application';
  if (app) renderScreen(app, screen);
  else renderList();
  window.scrollTo(0, 0);
}

if (root) {
  window.addEventListener('hashchange', () => void route());
  void route();
}
