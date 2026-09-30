/**
 * Application Migration: one application at a time, in three stages.
 *
 *   Stage 1  Know the application   (the app list, then five screens)
 *   Stage 2  Choose the cloud
 *   Stage 3  The runbook
 *
 * Stage 1 is four screens of questions, three sections each, full width, and
 * a fifth that is the assessment: what the answers say, and where the user
 * chooses the route. Every answer is the user's; the page only checks.
 * Applications are kept in this browser (the `apps` store) and saved as they
 * are typed.
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

const STAGES = ['Know the application', 'Choose the cloud', 'Runbook'];

function stageStrip(current: number): HTMLElement {
  return el(
    'div',
    { class: 'pill-row', attrs: { 'aria-label': 'Stages' } },
    ...STAGES.map((title, i) =>
      el('span', { class: 'pill', style: i === current ? { borderColor: 'var(--accent)', color: 'var(--accent)' } : {} }, `Stage ${i + 1} · ${title}${i > current ? ' (next)' : ''}`),
    ),
  );
}

function when(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

// --- The application list ---------------------------------------------------

function progressOf(app: AppRecord): string {
  const parts = [identityProgress(app.identity), continuityProgress(app.continuity), loadProgress(app.load)];
  const answered = parts.reduce((n, p) => n + p.answered, 0);
  const of = parts.reduce((n, p) => n + p.of, 0);
  return `${answered} of ${of}`;
}

function renderList(): void {
  if (!root) return;
  clear(root);
  const add = el('button', { class: 'btn btn-primary', text: '+ Add application', attrs: { type: 'button' }, on: { click: () => void addApp() } });
  const body =
    apps.length === 0
      ? el('p', { class: 'empty', text: 'No applications yet. Add the first one: everything about it is answered screen by screen, and it is kept in this browser.' })
      : el(
          'div',
          { class: 'table-wrap' },
          el(
            'table',
            {},
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
                  el('td', { class: 'muted', text: when(app.updated) }),
                  el('td', {}, el('div', { class: 'btn-row' }, el('a', { class: 'btn btn-small', text: 'Open', attrs: { href: `#app=${app.id}` } }), deleteButton(app))),
                ),
              ),
            ),
          ),
        );
  append(
    root,
    stageStrip(0),
    el(
      'section',
      { class: 'card' },
      el('div', { class: 'wizard-head' }, el('div', {}, el('h2', { text: 'Applications' }), el('p', { class: 'muted', text: 'Every application to be moved, one profile each. Open one to answer its questions.' })), add),
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

// --- Fields -----------------------------------------------------------------

type Answers = Record<string, string | string[]>;

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
}

function textField(obj: Answers, key: string, label: string, opts: { required?: boolean; hint?: string; area?: boolean; placeholder?: string; numeric?: boolean } = {}): HTMLElement {
  const id = `f-${key}`;
  const input = opts.area
    ? el('textarea', { id, attrs: { rows: 2, placeholder: opts.placeholder } })
    : el('input', { id, attrs: { type: 'text', inputmode: opts.numeric ? 'numeric' : null, placeholder: opts.placeholder, autocomplete: 'off' } });
  input.value = String(obj[key] ?? '');
  input.addEventListener('input', () => {
    obj[key] = input.value;
    changed();
  });
  return el(
    'div',
    { class: `field${opts.area ? ' field-wide' : ''}` },
    el('label', { attrs: { for: id } }, label, opts.required ? el('span', { class: 'required', text: ' *' }) : null),
    input,
    opts.hint ? el('div', { class: 'field-hint', text: opts.hint }) : null,
  );
}

/** A closed set, with its "Other" box shown only when Other is picked. */
function selectField(obj: Answers, key: string, label: string, options: readonly Option[], other?: { key: string; label: string }, hint?: string): HTMLElement[] {
  const id = `f-${key}`;
  const select = el('select', { id }, el('option', { text: 'Choose…', attrs: { value: '' } }), ...options.map((o) => el('option', { text: o.label, attrs: { value: o.value } })));
  select.value = String(obj[key] ?? '');
  const fields: HTMLElement[] = [el('div', { class: 'field' }, el('label', { attrs: { for: id }, text: label }), select, hint ? el('div', { class: 'field-hint', text: hint }) : null)];
  let otherField: HTMLElement | null = null;
  if (other) {
    otherField = textField(obj, other.key, other.label, { required: true });
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
function checkboxField(obj: Answers, key: string, label: string, options: readonly Option[], onChange?: () => void): HTMLElement {
  const chosen = new Set(Array.isArray(obj[key]) ? (obj[key] as string[]) : []);
  return el(
    'div',
    { class: 'field' },
    el('span', { class: 'field-label', text: label }),
    el(
      'div',
      { class: 'checkbox-group' },
      ...options.map((o) => {
        const box = el('input', { attrs: { type: 'checkbox', value: o.value, checked: chosen.has(o.value) } });
        box.addEventListener('change', () => {
          if (box.checked) chosen.add(o.value);
          else chosen.delete(o.value);
          obj[key] = options.map((x) => x.value).filter((v) => chosen.has(v));
          changed();
          onChange?.();
        });
        return el('label', { class: 'checkbox-inline' }, box, ` ${o.label}`);
      }),
    ),
  );
}

// --- The sections -------------------------------------------------------------

const SECTIONS: Partial<Record<CardId, (app: AppRecord) => HTMLElement[]>> = {
  identity: (app) => {
    const i = app.identity as unknown as Answers;
    return [
      textField(i, 'name', 'Application name', { required: true, placeholder: 'e.g. Case Management System' }),
      textField(i, 'businessUnit', 'Business unit'),
      textField(i, 'businessOwner', 'Business owner / team'),
      textField(i, 'technicalOwner', 'Technical owner'),
      ...selectField(i, 'vendor', 'Vendor', VENDORS, { key: 'vendorOther', label: 'Vendor name' }),
      ...selectField(i, 'sourceEnvironment', 'Source environment (today)', SOURCE_ENVIRONMENTS),
      ...selectField(i, 'hostingPlatform', 'Current hosting platform', HOSTING_PLATFORMS, { key: 'hostingOther', label: 'Hosting platform name' }),
      textField(i, 'description', 'Short description', { area: true, placeholder: 'What it does and who uses it' }),
      textField(i, 'notes', 'Notes', { area: true, placeholder: 'Key constraints, special requirements, known pain points' }),
    ];
  },
  continuity: (app) => {
    const c = app.continuity as unknown as Answers;
    const scale = selectField(c, 'nonProdScale', 'Non-prod scale vs prod', NON_PROD_SCALE);
    const showScale = () => {
      const nonProd = (c['environments'] as string[]).some((e) => e !== 'prod' && e !== 'dr');
      for (const f of scale) f.hidden = !nonProd;
    };
    const out = [
      ...selectField(c, 'criticality', 'Business criticality', CRITICALITY),
      ...selectField(c, 'uptime', 'Uptime target', UPTIME),
      ...selectField(c, 'drToday', 'DR today', DR_TODAY),
      ...selectField(c, 'rto', 'RTO: how long it can be down', RTO),
      ...selectField(c, 'rpo', 'RPO: how much data it can lose', RPO),
      checkboxField(c, 'environments', 'Environments in scope', ENVIRONMENTS, showScale),
      ...scale,
    ];
    showScale();
    return out;
  },
  load: (app) => {
    const l = app.load as unknown as Answers;
    return [
      textField(l, 'peakUsers', 'Peak concurrent users', { numeric: true, placeholder: 'e.g. 5000' }),
      textField(l, 'peakRps', 'Peak requests per second', { numeric: true, placeholder: 'e.g. 200' }),
      ...selectField(l, 'busyHours', 'When it is busy', BUSY_HOURS),
      ...selectField(l, 'seasonality', 'Seasonal peaks', SEASONALITY),
      ...selectField(l, 'gpu', 'GPU', GPU),
    ];
  },
};

function goTo(screen: ScreenId): void {
  location.hash = `app=${openId}&screen=${screen}`;
}

function screenIndex(id: ScreenId): number {
  return SCREENS.findIndex((s) => s.id === id);
}

/** The nearest built screen before or after this one. */
function neighbour(at: number, step: 1 | -1): (typeof SCREENS)[number] | undefined {
  for (let i = at + step; i >= 0 && i < SCREENS.length; i += step) {
    const s = SCREENS[i];
    if (s && screenBuilt(s)) return s;
  }
  return undefined;
}

function screenTabs(active: ScreenId): HTMLElement {
  return el(
    'div',
    { class: 'wizard-steps-list', attrs: { role: 'list', 'aria-label': 'Screens' } },
    ...SCREENS.map((s, i) => {
      const built = screenBuilt(s);
      return el('button', {
        class: `btn btn-small${s.id === active ? ' btn-primary' : ''}`,
        text: `${i + 1} · ${s.title}${built ? '' : ' (built next)'}`,
        attrs: { type: 'button', disabled: !built, 'aria-current': s.id === active ? 'step' : null },
        on: { click: () => goTo(s.id) },
      });
    }),
  );
}

function navRow(at: number): HTMLElement {
  const prev = neighbour(at, -1);
  const next = neighbour(at, 1);
  statusLine = el('span', { class: 'muted small', text: `Saved ${when(current()?.updated ?? '')}` });
  return el(
    'div',
    { class: 'wizard-nav btn-row' },
    prev
      ? el('button', { class: 'btn', text: `← ${prev.title}`, attrs: { type: 'button' }, on: { click: () => goTo(prev.id) } })
      : el('a', { class: 'btn', text: '← All applications', attrs: { href: '#' } }),
    statusLine,
    next ? el('button', { class: 'btn btn-primary', text: `Next: ${next.title} →`, attrs: { type: 'button' }, on: { click: () => goTo(next.id) } }) : null,
  );
}

function renderScreen(app: AppRecord, screenId: ScreenId): void {
  if (!root) return;
  clear(root);
  const at = screenIndex(screenId);
  const screen = SCREENS[at];
  if (!screen) return;
  const head = el(
    'div',
    { class: 'wizard-head' },
    el('div', {}, el('h2', { text: `${displayName(app)} · ${screen.title}` }), el('p', { class: 'muted', text: `Stage 1, screen ${at + 1} of ${SCREENS.length}` })),
    el('a', { class: 'btn btn-small', text: 'All applications', attrs: { href: '#' } }),
  );
  const body =
    screen.id === 'assessment'
      ? assessmentBody(app)
      : screen.cards.map((cardId) => {
          const card = CARDS.find((c) => c.id === cardId);
          return el('fieldset', { class: 'appmig-section' }, el('legend', { text: card?.title ?? cardId }), el('div', { class: 'field-grid' }, ...(SECTIONS[cardId]?.(app) ?? [])));
        });
  append(root, stageStrip(0), el('section', { class: 'card appmig' }, head, screenTabs(screenId), ...body, navRow(at)));
}

// --- The assessment (screen 5) -------------------------------------------------

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
    el('div', { class: 'pill-row' }, ...pills.map(([k, v]) => el('span', { text: `${k}: ${v}` }))),
    el(
      'fieldset',
      { class: 'appmig-section' },
      el('legend', { text: 'What is answered' }),
      el(
        'table',
        {},
        el('thead', {}, el('tr', {}, el('th', { text: 'Section' }), el('th', { text: 'Answered' }), el('th', { text: 'Still needed' }))),
        el(
          'tbody',
          {},
          ...rows.map(([name, p, problems]) =>
            el('tr', {}, el('td', { text: name }), el('td', { text: `${p.answered} of ${p.of}` }), el('td', { class: problems.length ? 'required' : 'muted', text: problems.join(' ') || 'Nothing' })),
          ),
        ),
      ),
    ),
    el(
      'fieldset',
      { class: 'appmig-section' },
      el('legend', { text: 'What the answers say' }),
      signals.length > 0 ? el('ul', {}, ...signals.map((s) => el('li', { text: s }))) : el('p', { class: 'muted', text: 'Nothing yet.' }),
    ),
    el(
      'fieldset',
      { class: 'appmig-section' },
      el('legend', { text: 'Still to come' }),
      el('p', { class: 'muted', text: 'The readiness score, the hard gates, the risk and the reasons for each route appear here as screens 2 to 4 are built, and you choose the route here at the end of Stage 1.' }),
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
