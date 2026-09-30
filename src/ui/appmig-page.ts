/**
 * Application Migration: one application at a time, in three stages.
 *
 *   Stage 1  Know the application   (the app list, then five steps)
 *   Stage 2  Choose the cloud
 *   Stage 3  The runbook
 *
 * Stage 1 is four steps of questions, three sections each, and a fifth that
 * is the assessment, where the user chooses the route. The questions are
 * data (appmig/sections.ts); this page draws them in the toolkit's usual
 * cards, tabs and fields. Every answer is the user's; the page only checks.
 * Applications are kept in this browser (the `apps` store), saved as typed.
 */

import { el, clear, append } from './dom.ts';
import { CARDS, SCREENS, displayName, newApp, sourceLabel, vendorLabel, type AppRecord, type CardId, type Option, type ScreenId } from '../appmig/model.ts';
import { FIELDS, type Answers, type Field, type Row } from '../appmig/sections.ts';
import { ROUTES, answersFor, problems, progress, readiness, risk, signals, suggestedRoute } from '../appmig/assess.ts';
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

function overall(app: AppRecord): { answered: number; of: number } {
  return CARDS.reduce((sum, c) => {
    const p = progress(app, c.id);
    return { answered: sum.answered + p.answered, of: sum.of + p.of };
  }, { answered: 0, of: 0 });
}

// --- The application list ---------------------------------------------------

function renderList(): void {
  if (!root) return;
  clear(root);
  const add = el('button', { class: 'btn btn-primary', text: '+ Add application', attrs: { type: 'button' }, on: { click: () => void addApp() } });
  const body =
    apps.length === 0
      ? el('p', { class: 'empty', text: 'No applications yet. Add the first one: everything about it is answered step by step, and it is kept in this browser.' })
      : el(
          'div',
          { class: 'table-wrap' },
          el(
            'table',
            {},
            el('thead', {}, el('tr', {}, ...['Application', 'Business owner', 'Vendor', 'Source environment', 'Answered', 'Route', 'Last changed', ''].map((h) => el('th', { text: h })))),
            el(
              'tbody',
              {},
              ...apps.map((app) => {
                const p = overall(app);
                return el(
                  'tr',
                  {},
                  el('td', {}, el('a', { text: displayName(app), attrs: { href: `#app=${app.id}` } })),
                  el('td', { text: app.identity.businessOwner }),
                  el('td', { text: vendorLabel(app.identity) }),
                  el('td', { text: sourceLabel(app.identity) }),
                  el('td', { text: `${p.answered} of ${p.of}` }),
                  el('td', { text: ROUTES.find((r) => r.value === app.route)?.label.split(' (')[0] ?? '' }),
                  el('td', { class: 'muted', text: when(app.updated) }),
                  el('td', {}, el('div', { class: 'btn-row' }, el('a', { class: 'btn btn-small', text: 'Open', attrs: { href: `#app=${app.id}` } }), deleteButton(app))),
                );
              }),
            ),
          ),
        );
  append(
    root,
    el(
      'section',
      { class: 'card' },
      el('div', { class: 'card-title' }, el('h2', { text: 'Applications' }), add),
      el('p', { class: 'muted', text: 'Every application to be moved, one profile each. Open one to answer its questions.' }),
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
  const app = newApp(crypto.randomUUID(), new Date().toISOString());
  if (!(await saveApp(app))) {
    alert('This browser will not store the application (private window or storage blocked), so it cannot be kept.');
    return;
  }
  apps = await listApps();
  location.hash = `app=${app.id}`;
}

// --- Drawing a field from its definition -----------------------------------------

function selectFor(options: readonly Option[], value: string, id?: string): HTMLSelectElement {
  const select = el('select', { id }, el('option', { text: 'Select…', attrs: { value: '' } }), ...options.map((o) => el('option', { text: o.label, attrs: { value: o.value } })));
  select.value = value;
  return select;
}

function rowsEditor(a: Answers, f: Field): HTMLElement {
  const columns = f.columns ?? [];
  const tbody = el('tbody');
  const read = (): Row[] => (Array.isArray(a[f.key]) ? (a[f.key] as Row[]) : []);
  const draw = () => {
    clear(tbody);
    const rows = read();
    rows.forEach((row, n) => {
      append(
        tbody,
        el(
          'tr',
          {},
          ...columns.map((c) => {
            const control = c.options
              ? selectFor(c.options, row[c.key] ?? '')
              : el('input', { attrs: { type: 'text', inputmode: c.numeric ? 'decimal' : null, placeholder: c.placeholder, 'aria-label': c.label } });
            if (control instanceof HTMLInputElement) control.value = row[c.key] ?? '';
            control.addEventListener(control instanceof HTMLSelectElement ? 'change' : 'input', () => {
              row[c.key] = control.value;
              changed();
            });
            return el('td', {}, control);
          }),
          el(
            'td',
            {},
            el('button', {
              class: 'btn btn-small',
              text: '×',
              attrs: { type: 'button', title: 'Remove this row' },
              on: {
                click: () => {
                  rows.splice(n, 1);
                  changed();
                  draw();
                },
              },
            }),
          ),
        ),
      );
    });
  };
  draw();
  const addRow = el('button', {
    class: 'btn btn-small',
    text: `+ Add ${f.label.toLowerCase().replace(/s$/, '')}`,
    attrs: { type: 'button' },
    on: {
      click: () => {
        const rows = read();
        rows.push(Object.fromEntries(columns.map((c) => [c.key, ''])));
        a[f.key] = rows;
        changed();
        draw();
      },
    },
  });
  return el(
    'div',
    { class: 'field appmig-wide' },
    el('span', { class: 'field-label', text: f.label }),
    f.hint ? el('div', { class: 'field-hint', text: f.hint }) : null,
    el('div', { class: 'table-wrap' }, el('table', { class: 'appmig-rows' }, el('thead', {}, el('tr', {}, ...columns.map((c) => el('th', { text: c.label })), el('th'))), tbody)),
    addRow,
  );
}

function fieldFor(a: Answers, f: Field, refresh: () => void): HTMLElement {
  const id = `f-${f.key}`;
  if (f.kind === 'rows') return rowsEditor(a, f);
  let control: HTMLElement;
  if (f.kind === 'select') {
    const select = selectFor(f.options ?? [], typeof a[f.key] === 'string' ? (a[f.key] as string) : '', id);
    select.addEventListener('change', () => {
      a[f.key] = select.value;
      changed();
      refresh();
    });
    control = select;
  } else if (f.kind === 'checks') {
    const chosen = new Set(Array.isArray(a[f.key]) ? (a[f.key] as string[]) : []);
    control = el(
      'div',
      { class: 'checkbox-group' },
      ...(f.options ?? []).map((o) => {
        const box = el('input', { attrs: { type: 'checkbox', value: o.value, checked: chosen.has(o.value) } });
        box.addEventListener('change', () => {
          if (box.checked) chosen.add(o.value);
          else chosen.delete(o.value);
          a[f.key] = (f.options ?? []).map((x) => x.value).filter((v) => chosen.has(v));
          changed();
          refresh();
        });
        return el('label', { class: 'checkbox-inline' }, box, ` ${o.label}`);
      }),
    );
  } else {
    const input =
      f.kind === 'area'
        ? el('textarea', { id, attrs: { rows: 2, placeholder: f.placeholder } })
        : el('input', { id, attrs: { type: 'text', inputmode: f.kind === 'number' ? 'numeric' : null, placeholder: f.placeholder, autocomplete: 'off' } });
    input.value = typeof a[f.key] === 'string' ? (a[f.key] as string) : '';
    input.addEventListener('input', () => {
      a[f.key] = input.value;
      changed();
    });
    control = input;
  }
  const labelEl = f.kind === 'checks' ? el('span', { class: 'field-label' }, f.label) : el('label', { attrs: { for: id } }, f.label);
  if (f.required) labelEl.append(el('span', { class: 'required', text: ' *' }));
  return el('div', { class: `field${f.wide || f.kind === 'area' ? ' appmig-wide' : ''}` }, labelEl, control, f.hint ? el('div', { class: 'field-hint', text: f.hint }) : null);
}

/** One section as a card; fields that depend on an answer appear and disappear with it. */
function sectionCard(app: AppRecord, card: CardId): HTMLElement {
  const a = answersFor(app, card);
  const grid = el('div', { class: 'field-grid' });
  const fields = FIELDS[card];
  const drawn = new Map<Field, HTMLElement>();
  const refresh = () => {
    for (const [f, node] of drawn) node.hidden = !!f.showIf && !f.showIf(a);
  };
  for (const f of fields) {
    const node = fieldFor(a, f, refresh);
    drawn.set(f, node);
    grid.append(node);
  }
  refresh();
  const title = CARDS.find((c) => c.id === card)?.title ?? card;
  return el('section', { class: 'card appmig' }, el('div', { class: 'card-title' }, el('h3', { text: title })), grid);
}

// --- Steps ------------------------------------------------------------------

function goTo(screen: ScreenId): void {
  location.hash = `app=${openId}&screen=${screen}`;
}

const STEP_NOTES: Record<ScreenId, string> = {
  application: 'Who owns it, how critical it is, and how much load it carries.',
  build: 'How it is built, the servers it runs on, and its data.',
  links: 'What it connects to, the rules it must follow, and its network.',
  today: 'What stands in the way, how ready it is, and how it is run today.',
  assessment: 'What the answers say. You choose the route here.',
};

function appHeader(app: AppRecord, screenId: ScreenId): HTMLElement {
  const picker = el(
    'select',
    { attrs: { 'aria-label': 'Application' } },
    ...apps.map((a) => el('option', { text: displayName(a), attrs: { value: a.id } })),
  );
  picker.value = app.id;
  picker.addEventListener('change', () => {
    location.hash = `app=${picker.value}&screen=${screenId}`;
  });
  const tabs = el(
    'div',
    { class: 'tabs', attrs: { role: 'tablist' } },
    ...SCREENS.map((s, i) =>
      el('span', {
        class: `tab${s.id === screenId ? ' active' : ''}`,
        text: `${i + 1} · ${s.title}`,
        attrs: { role: 'tab', tabindex: 0, 'aria-selected': String(s.id === screenId) },
        on: {
          click: () => goTo(s.id),
          keydown: (e) => {
            if ((e as KeyboardEvent).key === 'Enter') goTo(s.id);
          },
        },
      }),
    ),
  );
  const at = SCREENS.findIndex((s) => s.id === screenId);
  return el(
    'section',
    { class: 'card' },
    el(
      'div',
      { class: 'card-title' },
      el('h2', { text: displayName(app) }),
      el('div', { class: 'btn-row' }, picker, el('a', { class: 'btn btn-small', text: 'All applications', attrs: { href: '#' } })),
    ),
    tabs,
    el('p', { class: 'muted small', style: { marginTop: 'var(--space-3)' }, text: `Stage 1 · Know the application · Step ${at + 1} of ${SCREENS.length}: ${STEP_NOTES[screenId]}` }),
  );
}

function navRow(at: number): HTMLElement {
  const prev = SCREENS[at - 1];
  const next = SCREENS[at + 1];
  statusLine = el('span', { class: 'muted small', text: `Saved ${when(current()?.updated ?? '')}` });
  return el(
    'div',
    { class: 'btn-row appmig-nav' },
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
  const at = SCREENS.findIndex((s) => s.id === screenId);
  const screen = SCREENS[at];
  if (!screen) return;
  const body = screen.id === 'assessment' ? assessmentCards(app) : screen.cards.map((c) => sectionCard(app, c));
  append(root, appHeader(app, screenId), ...body, navRow(at));
}

// --- The assessment (step 5) -------------------------------------------------

function assessmentCards(app: AppRecord): HTMLElement[] {
  const score = readiness(app);
  const suggestion = suggestedRoute(app);
  const r = risk(app);
  const routeLabel = (v: string) => ROUTES.find((x) => x.value === v)?.label ?? v;

  const choose = el('select', { id: 'f-route' }, el('option', { text: 'Select…', attrs: { value: '' } }), ...ROUTES.map((x) => el('option', { text: x.label, attrs: { value: x.value } })));
  choose.value = app.route;
  choose.addEventListener('change', () => {
    app.route = choose.value;
    changed();
  });

  const stats = el(
    'div',
    { class: 'stat-grid' },
    el('div', { class: 'stat' }, el('div', { class: 'stat-label', text: 'Readiness score' }), el('div', { class: 'stat-value', text: score === null ? '—' : `${score}` }), el('div', { class: 'stat-sub', text: score === null ? 'Rate all six in step 4' : 'of 100' })),
    el('div', { class: 'stat' }, el('div', { class: 'stat-label', text: 'Risk' }), el('div', { class: 'stat-value', text: r.level }), el('div', { class: 'stat-sub', text: `${r.points} points` })),
    el('div', { class: 'stat' }, el('div', { class: 'stat-label', text: 'Suggested route' }), el('div', { class: 'stat-value', text: suggestion ? routeLabel(suggestion.route).split(' (')[0] ?? '' : '—' }), el('div', { class: 'stat-sub', text: suggestion ? 'from the gates and the score' : 'Needs the gates or all six ratings' })),
    el('div', { class: 'stat' }, el('div', { class: 'stat-label', text: 'Answered' }), el('div', { class: 'stat-value', text: `${overall(app).answered}` }), el('div', { class: 'stat-sub', text: `of ${overall(app).of} questions` })),
  );

  const decision = el(
    'section',
    { class: 'card' },
    el('div', { class: 'card-title' }, el('h3', { text: 'The route' })),
    stats,
    suggestion ? el('p', {}, el('strong', { text: `Suggested: ${routeLabel(suggestion.route)}. ` }), suggestion.because) : null,
    r.reasons.length > 0 ? el('p', { class: 'muted small', text: `Risk from: ${r.reasons.join('; ')}.` }) : null,
    el('div', { class: 'field', style: { maxWidth: '28rem' } }, el('label', { attrs: { for: 'f-route' }, text: 'Route for this application' }), choose, el('div', { class: 'field-hint', text: 'Your decision. The suggestion is only there to compare against.' })),
  );

  const table = el(
    'section',
    { class: 'card' },
    el('div', { class: 'card-title' }, el('h3', { text: 'What is answered' })),
    el(
      'div',
      { class: 'table-wrap' },
      el(
        'table',
        {},
        el('thead', {}, el('tr', {}, el('th', { text: 'Section' }), el('th', { text: 'Answered' }), el('th', { text: 'Still needed' }))),
        el(
          'tbody',
          {},
          ...SCREENS.flatMap((s) => [...s.cards]).map((id) => CARDS.find((c) => c.id === id)!).map((c) => {
            const p = progress(app, c.id);
            const needs = problems(app, c.id, apps);
            return el('tr', {}, el('td', { text: c.title }), el('td', { text: `${p.answered} of ${p.of}` }), el('td', { class: needs.length ? 'required' : 'muted', text: needs.join(' ') || 'Nothing' }));
          }),
        ),
      ),
    ),
  );

  const said = signals(app);
  const meaning = el(
    'section',
    { class: 'card' },
    el('div', { class: 'card-title' }, el('h3', { text: 'What the answers say' })),
    said.length === 0
      ? el('p', { class: 'muted', text: 'Nothing yet.' })
      : el('div', {}, ...said.map((s) => el('div', {}, el('h4', { text: s.card }), el('ul', {}, ...s.says.map((x) => el('li', { text: x })))))),
  );

  return [decision, meaning, table];
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
  const screen = SCREENS.find((s) => s.id === match?.[2])?.id ?? 'application';
  if (app) renderScreen(app, screen);
  else renderList();
  window.scrollTo(0, 0);
}

if (root) {
  window.addEventListener('hashchange', () => void route());
  void route();
}

