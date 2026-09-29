/**
 * Application Migration: one application at a time, in three stages.
 *
 *   Stage 1  Know the application   (the app list, then its cards)
 *   Stage 2  Choose the cloud
 *   Stage 3  The runbook
 *
 * The layout is the original decision wizard's: the questions in the left
 * card, a step at a time, and the assessment in the right card, updated as
 * the answers come in. Every answer is the user's; the page only checks.
 * Applications are kept in this browser (the `apps` store) and saved as they
 * are typed.
 */

import { el, clear, append } from './dom.ts';
import {
  BUILT,
  CARDS,
  HOSTING_PLATFORMS,
  SOURCE_ENVIRONMENTS,
  VENDORS,
  displayName,
  hostingLabel,
  identityProblems,
  identityProgress,
  identitySignals,
  newApp,
  sourceLabel,
  vendorLabel,
  type AppRecord,
  type Identity,
  type Option,
} from '../appmig/model.ts';
import { deleteApp, listApps, saveApp } from '../appmig/store.ts';

const root = document.getElementById('migration-root');

let apps: AppRecord[] = [];
let openId: string | null = null;
let saveTimer: ReturnType<typeof setTimeout> | undefined;
let statusLine: HTMLElement | null = null;
let assessment: HTMLElement | null = null;

const STAGES = ['Know the application', 'Choose the cloud', 'Runbook'];

function stageStrip(current: number): HTMLElement {
  return el(
    'ol',
    { class: 'wizard-steps-list', attrs: { 'aria-label': 'Stages' } },
    ...STAGES.map((title, i) =>
      el(
        'li',
        {},
        el('span', { class: `pill${i === current ? ' is-active-stage' : ''}`, style: i === current ? { borderColor: 'var(--accent)', color: 'var(--accent)' } : {} }, `Stage ${i + 1} · ${title}${i > current ? ' (next)' : ''}`),
      ),
    ),
  );
}

function when(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

// --- The application list ---------------------------------------------------

function renderList(): void {
  if (!root) return;
  clear(root);
  const add = el('button', { class: 'btn btn-primary', text: '+ Add application', attrs: { type: 'button' }, on: { click: () => void addApp() } });
  const body =
    apps.length === 0
      ? el('p', { class: 'empty', text: 'No applications yet. Add the first one: everything about it is answered card by card, and it is kept in this browser.' })
      : el(
          'div',
          { class: 'table-wrap' },
          el(
            'table',
            {},
            el('thead', {}, el('tr', {}, ...['Application', 'Business owner', 'Vendor', 'Source environment', 'Card 1', 'Last changed', ''].map((h) => el('th', { text: h })))),
            el(
              'tbody',
              {},
              ...apps.map((app) => {
                const progress = identityProgress(app.identity);
                return el(
                  'tr',
                  {},
                  el('td', {}, el('a', { text: displayName(app), attrs: { href: `#app=${app.id}` } })),
                  el('td', { text: app.identity.businessOwner }),
                  el('td', { text: vendorLabel(app.identity) }),
                  el('td', { text: sourceLabel(app.identity) }),
                  el('td', { text: `${progress.answered} of ${progress.of}` }),
                  el('td', { class: 'muted', text: when(app.updated) }),
                  el('td', {}, el('div', { class: 'btn-row' }, el('a', { class: 'btn btn-small', text: 'Open', attrs: { href: `#app=${app.id}` } }), deleteButton(app))),
                );
              }),
            ),
          ),
        );
  append(
    root,
    stageStrip(0),
    el(
      'section',
      { class: 'card' },
      el('div', { class: 'wizard-head' }, el('div', {}, el('h2', { text: 'Applications' }), el('p', { class: 'muted', text: 'Every application to be moved, one profile each. Open one to answer its cards.' })), add),
      body,
    ),
  );
}

/** Delete asks on the button itself: the first press arms it, the second deletes. */
function deleteButton(app: AppRecord): HTMLButtonElement {
  const button = el('button', { class: 'btn btn-small btn-danger', text: 'Delete', attrs: { type: 'button' } });
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
  const now = new Date().toISOString();
  const app = newApp(crypto.randomUUID(), now);
  if (!(await saveApp(app))) {
    alert('This browser will not store the application (private window or storage blocked), so it cannot be kept.');
    return;
  }
  apps = await listApps();
  location.hash = `app=${app.id}`;
}

// --- One application: card 1 -----------------------------------------------

function current(): AppRecord | undefined {
  return apps.find((a) => a.id === openId);
}

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
  renderAssessment();
}

function textField(identity: Identity, key: keyof Identity, label: string, opts: { required?: boolean; hint?: string; area?: boolean; placeholder?: string } = {}): HTMLElement {
  const id = `f-${key}`;
  const input = opts.area
    ? el('textarea', { id, attrs: { rows: 3, placeholder: opts.placeholder } })
    : el('input', { id, attrs: { type: 'text', placeholder: opts.placeholder, autocomplete: 'off' } });
  input.value = identity[key];
  input.addEventListener('input', () => {
    identity[key] = input.value;
    changed();
  });
  return el(
    'div',
    { class: 'field' },
    el('label', { attrs: { for: id } }, label, opts.required ? el('span', { class: 'required', text: ' *' }) : null),
    input,
    opts.hint ? el('div', { class: 'field-hint', text: opts.hint }) : null,
  );
}

/** A closed set, with its "Other" box shown only when Other is picked. */
function selectField(identity: Identity, key: keyof Identity, label: string, options: readonly Option[], other?: { key: keyof Identity; label: string }, hint?: string): HTMLElement[] {
  const id = `f-${key}`;
  const select = el('select', { id }, el('option', { text: 'Choose…', attrs: { value: '' } }), ...options.map((o) => el('option', { text: o.label, attrs: { value: o.value } })));
  select.value = identity[key];
  const fields: HTMLElement[] = [el('div', { class: 'field' }, el('label', { attrs: { for: id }, text: label }), select, hint ? el('div', { class: 'field-hint', text: hint }) : null)];
  let otherField: HTMLElement | null = null;
  if (other) {
    otherField = textField(identity, other.key, other.label, { required: true });
    otherField.hidden = identity[key] !== 'Other';
    fields.push(otherField);
  }
  select.addEventListener('change', () => {
    identity[key] = select.value;
    if (otherField) otherField.hidden = select.value !== 'Other';
    changed();
  });
  return fields;
}

function cardDots(): HTMLElement {
  return el(
    'div',
    { class: 'wizard-steps-list', attrs: { role: 'list', 'aria-label': 'Cards' } },
    ...CARDS.map((card, i) => {
      const built = BUILT.has(card.id);
      return el('button', {
        class: `wizard-dot${card.id === 'identity' ? ' is-active' : ''}`,
        text: i + 1,
        attrs: { type: 'button', title: built ? card.title : `${card.title} (built next)`, disabled: !built, 'aria-current': card.id === 'identity' ? 'step' : null },
      });
    }),
  );
}

function renderApp(app: AppRecord): void {
  if (!root) return;
  clear(root);
  const i = app.identity;
  const next = CARDS[1];
  statusLine = el('span', { class: 'muted small', text: `Saved ${when(app.updated)}` });

  const questions = el(
    'section',
    { class: 'card decision-wizard appmig' },
    el('div', { class: 'wizard-head' }, el('div', {}, el('h2', { text: 'Card 1 · Identity' }), el('p', { class: 'muted', text: 'Who and what the application is, and where it runs today.' })), el('span', { class: 'step-counter', text: `1 of ${CARDS.length}` })),
    cardDots(),
    el(
      'div',
      { class: 'field-grid' },
      textField(i, 'name', 'Application name', { required: true, placeholder: 'e.g. Case Management System' }),
      textField(i, 'businessUnit', 'Business unit'),
      textField(i, 'businessOwner', 'Business owner / team'),
      textField(i, 'technicalOwner', 'Technical owner'),
      ...selectField(i, 'vendor', 'Vendor', VENDORS, { key: 'vendorOther', label: 'Vendor name' }),
      ...selectField(i, 'sourceEnvironment', 'Source environment (today)', SOURCE_ENVIRONMENTS),
      ...selectField(i, 'hostingPlatform', 'Current hosting platform', HOSTING_PLATFORMS, { key: 'hostingOther', label: 'Hosting platform name' }),
      textField(i, 'description', 'Short description', { area: true, placeholder: 'What it does and who uses it' }),
      textField(i, 'notes', 'Notes', { area: true, placeholder: 'Key constraints, special requirements, known pain points' }),
    ),
    el(
      'div',
      { class: 'wizard-nav btn-row' },
      el('a', { class: 'btn', text: '← All applications', attrs: { href: '#' } }),
      statusLine,
      el('button', { class: 'btn btn-primary', text: `Next: ${next?.title ?? ''} →`, attrs: { type: 'button', disabled: true, title: 'Card 2 is built next' } }),
    ),
  );

  assessment = el('section', { class: 'card' });
  append(root, stageStrip(0), el('div', { class: 'wizard-grid' }, questions, assessment));
  renderAssessment();
}

/** The right card: what the answers so far say. It reports; it does not decide. */
function renderAssessment(): void {
  const app = current();
  if (!assessment || !app) return;
  const i = app.identity;
  const progress = identityProgress(i);
  const problems = identityProblems(app, apps);
  const signals = identitySignals(i);
  const pills = [
    ['Application', displayName(app)],
    ['Vendor', vendorLabel(i)],
    ['Source', sourceLabel(i)],
    ['Hosting', hostingLabel(i)],
  ].filter(([, v]) => v);
  clear(assessment);
  append(
    assessment,
    el('div', { class: 'wizard-head' }, el('div', {}, el('h2', { text: 'Assessment' }), el('p', { class: 'muted', text: 'Based on your answers so far' }))),
    el('div', { class: 'pill-row' }, ...pills.map(([k, v]) => el('span', { text: `${k}: ${v}` }))),
    el('h3', { text: 'Card 1 · Identity' }),
    el('p', { text: `${progress.answered} of ${progress.of} answered.` }),
    problems.length > 0
      ? el('ul', {}, ...problems.map((p) => el('li', { class: 'required', text: p.message })))
      : el('p', { class: 'muted', text: 'Nothing missing on this card.' }),
    el('h3', { text: 'What the answers say' }),
    signals.length > 0 ? el('ul', {}, ...signals.map((s) => el('li', { text: s }))) : el('p', { class: 'muted', text: 'Nothing yet.' }),
    el('h3', { text: 'Still to come' }),
    el('p', { class: 'muted', text: 'The readiness score, the hard gates, the risk and the reasons for each route appear here as the other cards are built. You choose the route at the end of Stage 1.' }),
  );
}

// --- Routing ----------------------------------------------------------------

async function route(): Promise<void> {
  // An edit still waiting for its save is saved before the page moves on.
  const pending = saveTimer !== undefined ? current() : undefined;
  clearTimeout(saveTimer);
  saveTimer = undefined;
  if (pending) await saveApp(pending);
  const match = /^#app=(.+)$/.exec(location.hash);
  apps = await listApps();
  const app = match ? apps.find((a) => a.id === match[1]) : undefined;
  openId = app?.id ?? null;
  if (app) renderApp(app);
  else renderList();
  window.scrollTo(0, 0);
}

if (root) {
  window.addEventListener('hashchange', () => void route());
  void route();
}
