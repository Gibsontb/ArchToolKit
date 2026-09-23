/**
 * Looking at one dashboard.
 *
 * A list of dashboards tells you there are three hundred and six of them. It
 * does not tell you which one is the one you are thinking of — and with
 * ninety-four called "troubleshoot VM template", the name will not either. What
 * identifies a dashboard is its shape: one wide chart across the top, four
 * scoreboards under it, a table down the left.
 *
 * The export carries that shape. Every widget has `gridsterCoords` — twelve
 * columns, rows of fixed height, both numbered from one — so the layout can be
 * drawn exactly as it was arranged, without the appliance and without a login.
 * The widgets are drawn as labelled boxes rather than as live charts, because
 * the data is not in the export and a box that says what it is beats a blank
 * rectangle pretending to be a graph.
 */

import { el, append, clear, replace } from './dom.js';
import { card } from './components.js';
import { DASHBOARD_COLUMNS, dashboardRows, widgetFamily,                                     } from '../aria/aria.js';

/** Row height in pixels. Aria's rows are short; this reads at a glance. */
const ROW = 22;

/** What each widget family is called on the drawing's key. */
export const FAMILY_LABEL                                   = {
  chart: 'Chart or scoreboard',
  table: 'Table or list',
  alert: 'Alerts',
  topology: 'Relationships',
  text: 'Text',
  picker: 'Picker — drives the others',
  other: 'Other',
};

/**
 * One dashboard, drawn.
 *
 * `viewNames` lets a View widget say what it shows: the widget's own title is
 * often a question ("9. Does the datastore serving the VM have latency?") while
 * the view it renders has the name you would search for.
 */
export function dashboardCanvas(dashboard           , viewNames                              )              {
  const rows = Math.max(dashboardRows(dashboard), 1);
  const canvas = el('div', { class: 'dash-canvas' });
  canvas.style.gridTemplateColumns = `repeat(${DASHBOARD_COLUMNS}, minmax(0, 1fr))`;
  canvas.style.gridAutoRows = `${ROW}px`;

  if (dashboard.widgets.length === 0) {
    return el('div', { class: 'empty', text: 'This dashboard has no widgets on it.' });
  }

  // Widgets in reading order, so tabbing through the drawing follows the eye.
  const ordered = [...dashboard.widgets].sort((a, b) => a.y - b.y || a.x - b.x);
  let viewIndex = 0;

  for (const widget of ordered) {
    const family = widgetFamily(widget.type);
    const box = el('div', {
      class: `dash-widget family-${family}${widget.collapsed ? ' is-collapsed' : ''}`,
      attrs: { title: `${widget.type} — ${widget.title || 'untitled'} (${widget.w}×${widget.h} at column ${widget.x}, row ${widget.y})` },
    });

    // The grid is one-based in the export and one-based in CSS, so the numbers
    // go straight in. Clamped because a widget dragged off the edge is stored
    // with an x that would silently push the whole row over.
    const column = Math.min(Math.max(widget.x, 1), DASHBOARD_COLUMNS);
    const span = Math.min(Math.max(widget.w, 1), DASHBOARD_COLUMNS - column + 1);
    box.style.gridColumn = `${column} / span ${span}`;
    box.style.gridRow = `${Math.max(widget.y, 1)} / span ${Math.max(widget.collapsed ? 1 : widget.h, 1)}`;

    append(box, el('div', { class: 'dash-widget-type', text: widget.type }));
    append(box, el('div', { class: 'dash-widget-title', text: widget.title || '(untitled)' }));

    if (widget.type === 'View' && viewNames) {
      const viewId = dashboard.viewIds[viewIndex];
      viewIndex += 1;
      const name = viewId ? viewNames.get(viewId) : undefined;
      if (name && name !== widget.title) {
        append(box, el('div', { class: 'dash-widget-view', text: `shows: ${name}` }));
      } else if (viewId && !name) {
        append(box, el('div', { class: 'dash-widget-view is-missing', text: 'the view it shows is not in the export' }));
      }
    }

    append(canvas, box);
  }

  canvas.style.minHeight = `${rows * ROW}px`;
  return canvas;
}

/** The key under a drawing, so the colours mean something. */
export function canvasKey()              {
  const key = el('div', { class: 'dash-key' });
  for (const [family, label] of Object.entries(FAMILY_LABEL)) {
    append(key, el('span', { class: `dash-key-item family-${family}`, text: label }));
  }
  return key;
}

/**
 * The viewer: one dashboard at a time, with a way to get to any other.
 *
 * The picker is grouped by shared and private, because that is the division
 * people care about when they are deciding what to keep.
 */
                                  
                                
                                                                    
                         
 

export function dashboardViewer(dashboards                      , views                           )                  {
  const viewNames = new Map(views.map((view) => [view.id, view.name]));
  const ordered = [...dashboards].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  let at = 0;

  const picker = el('select', { attrs: { 'aria-label': 'Dashboard' } })                     ;
  const shared = el('optgroup', { attrs: { label: 'Shared' } });
  const priv = el('optgroup', { attrs: { label: 'Not shared' } });
  ordered.forEach((dashboard, index) => {
    const option = el('option', {
      text: `${dashboard.name || '(unnamed)'} — ${dashboard.widgets.length} widget${dashboard.widgets.length === 1 ? '' : 's'}`,
      attrs: { value: String(index) },
    });
    append(dashboard.shared ? shared : priv, option);
  });
  if (shared.children.length > 0) append(picker, shared);
  if (priv.children.length > 0) append(picker, priv);

  const heading = el('div', { class: 'dash-heading' });
  const canvas = el('div', {});
  const position = el('span', { class: 'muted' });

  function show(index        )       {
    at = Math.min(Math.max(index, 0), ordered.length - 1);
    const dashboard = ordered[at];
    if (!dashboard) return;
    picker.value = String(at);
    position.textContent = `${at + 1} of ${ordered.length}`;

    const widgetKinds = [...new Set(dashboard.widgets.map((widget) => widget.type))];
    replace(
      heading,
      el('h3', { text: dashboard.name || '(unnamed)' }),
      el(
        'p',
        { class: 'muted' },
        el('span', { text: dashboard.shared ? 'Shared. ' : 'Not shared — it lives in one account. ' }),
        el('span', { text: `${dashboard.widgets.length} widget${dashboard.widgets.length === 1 ? '' : 's'}: ${widgetKinds.join(', ')}.` }),
        dashboard.created ? el('span', { text: ` Created ${new Date(dashboard.created).toISOString().slice(0, 10)}.` }) : el('span', {}),
      ),
    );
    replace(canvas, dashboardCanvas(dashboard, viewNames));
  }

  picker.addEventListener('change', () => show(Number(picker.value)));

  const controls = el(
    'div',
    { class: 'field-row dash-controls' },
    el('div', { class: 'field' }, el('div', { class: 'field-head' }, el('label', { text: 'Dashboard' })), picker),
    el(
      'div',
      { class: 'btn-row' },
      el('button', { class: 'btn btn-small', text: '← Previous', on: { click: () => show(at - 1) } }),
      el('button', { class: 'btn btn-small', text: 'Next →', on: { click: () => show(at + 1) } }),
      position,
    ),
  );

  const wrap = el('div', { class: 'stack' }, controls, heading, canvas, canvasKey());
  show(0);

  return {
    element: wrap,
    show(id        )       {
      const index = ordered.findIndex((dashboard) => dashboard.id === id);
      if (index < 0) return;
      show(index);
      wrap.scrollIntoView({ block: 'start', behavior: 'smooth' });
    },
  };
}

/** A small drawing of every dashboard, for scanning the whole set at once. */
export function contactGrid(dashboards                      , onPick                                )              {
  const grid = el('div', { class: 'dash-contact' });
  for (const dashboard of [...dashboards].sort((a, b) => a.name.localeCompare(b.name))) {
    const thumb = el('button', {
      class: 'dash-thumb',
      attrs: { type: 'button', title: `${dashboard.name} — ${dashboard.widgets.length} widgets` },
      on: { click: () => onPick(dashboard) },
    });
    const mini = dashboardCanvas(dashboard);
    mini.classList.add('is-mini');
    append(
      thumb,
      mini,
      el(
        'span',
        { class: 'dash-thumb-label' },
        el('strong', { text: dashboard.name || '(unnamed)' }),
        el('span', { class: 'muted', text: `${dashboard.widgets.length} widgets${dashboard.shared ? '' : ' · private'}` }),
      ),
    );
    append(grid, thumb);
  }
  return grid;
}

/** The viewer and the wall of thumbnails, wired to each other. */
export function mountDashboardView(
  container             ,
  dashboards                      ,
  views                           ,
)                  {
  const viewer = dashboardViewer(dashboards, views);
  const one = card('Dashboard', viewer.element);
  const all = card(
    `All ${dashboards.length}`,
    el('p', { class: 'muted', text: 'Click any of them to open it above. The drawing is the dashboard’s real layout — every widget is where it was arranged.' }),
    contactGrid(dashboards, (dashboard) => viewer.show(dashboard.id)),
  );

  clear(container);
  append(container, one, all);
  return viewer;
}
