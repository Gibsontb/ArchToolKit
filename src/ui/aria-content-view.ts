/**
 * Looking at one view, and at one report.
 *
 * The same problem as the dashboards and the same answer, because the export
 * carries enough to draw both:
 *
 *  - a view says what it presents (a list, a line chart, a donut, some text),
 *    over which object kinds, across what window, and — the part that matters —
 *    the columns it actually shows, in order, with the headings someone reads
 *    rather than the metric keys. "A list view of virtual machines" tells you
 *    nothing; its fourteen columns tell you whether it is the one you want.
 *  - a report says what it is made of: a cover page, a contents page, then the
 *    views and dashboards it prints, each with its orientation, and what
 *    formats it comes out as.
 *
 * Neither is drawn with data in it, because an export has none. A list is shown
 * as its real headers over a few ruled empty rows, which is what a person
 * recognises, and a chart as a labelled panel naming the series it plots.
 */

import { el, append, clear } from './dom.ts';
import { card } from './components.ts';
import { oneOfMany, type OneOfMany } from './one-of-many.ts';
import type { Dashboard, ReportDefinition, ReportSection, ViewDefinition } from '../aria/aria.ts';

/** What a presentation type is called, and whether it is a table or a chart. */
const PRESENTATION: Readonly<Record<string, { readonly label: string; readonly shape: 'table' | 'chart' | 'text' }>> = {
  list: { label: 'List', shape: 'table' },
  summary: { label: 'Summary', shape: 'table' },
  'line-chart': { label: 'Line chart', shape: 'chart' },
  'bar-chart': { label: 'Bar chart', shape: 'chart' },
  'donut-chart': { label: 'Donut chart', shape: 'chart' },
  'pie-chart': { label: 'Pie chart', shape: 'chart' },
  distribution: { label: 'Distribution', shape: 'chart' },
  text: { label: 'Text', shape: 'text' },
  image: { label: 'Image', shape: 'text' },
};

function presentationOf(view: ViewDefinition): { label: string; shape: 'table' | 'chart' | 'text' } {
  return PRESENTATION[view.presentation ?? ''] ?? { label: view.presentation || 'Unknown', shape: 'table' };
}

/**
 * A view, drawn.
 *
 * A list becomes its own headers over three ruled rows — enough to recognise
 * the thing without pretending there is data in it. A chart becomes a panel
 * naming what it plots.
 */
export function viewCanvas(view: ViewDefinition): HTMLElement {
  const { shape } = presentationOf(view);

  if (view.columns.length === 0) {
    return el(
      'div',
      { class: 'view-canvas is-empty' },
      el('p', { class: 'empty', text: shape === 'text' ? 'A text or image view — its content is held outside the view definition.' : 'This view declares no columns in the export.' }),
    );
  }

  if (shape === 'chart') {
    const panel = el('div', { class: 'view-canvas is-chart' });
    append(panel, el('div', { class: 'view-chart-face', text: presentationOf(view).label }));
    const list = el('ul', { class: 'view-series' });
    for (const column of view.columns) {
      append(list, el('li', {}, el('strong', { text: column.label }), el('code', { text: column.key })));
    }
    append(panel, list);
    return panel;
  }

  // A list: the real headers, then a few empty rows so it reads as a table.
  const head = el('tr');
  append(head, el('th', { class: 'view-col-object', text: 'Object' }));
  for (const column of view.columns) {
    append(head, el('th', { attrs: { title: column.key } }, el('span', { text: column.label }), el('code', { class: 'view-col-key', text: column.key })));
  }

  const body = el('tbody');
  for (let row = 0; row < 3; row += 1) {
    const tr = el('tr', { class: 'view-ghost-row' });
    append(tr, el('td', {}, el('span', { class: 'view-ghost' })));
    for (const column of view.columns) {
      append(tr, el('td', {}, el('span', { class: `view-ghost${column.text ? '' : ' is-number'}` })));
    }
    append(body, tr);
  }

  return el(
    'div',
    { class: 'view-canvas' },
    el('div', { class: 'table-wrap' }, el('table', { class: 'data-table view-table' }, el('thead', {}, head), body)),
    el('p', { class: 'muted view-foot', text: `${view.columns.length} column${view.columns.length === 1 ? '' : 's'}${view.pageSize ? ` · ${view.pageSize} rows a page` : ''}${view.timeRange ? ` · over ${view.timeRange}` : ''}` }),
  );
}

export function viewViewer(views: readonly ViewDefinition[], dashboards: readonly Dashboard[], reports: readonly ReportDefinition[]): OneOfMany {
  const onDashboards = new Set(dashboards.flatMap((dashboard) => dashboard.viewIds));
  const inReports = new Set(reports.flatMap((report) => report.sections.map((section) => section.contentKey ?? '')));

  return oneOfMany<ViewDefinition>({
    items: views,
    noun: 'View',
    idOf: (view) => view.id,
    sort: (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
    group: (view) => presentationOf(view).label,
    label: (view) => `${view.name || '(unnamed)'} — ${view.columns.length} column${view.columns.length === 1 ? '' : 's'}`,
    heading: (view) => {
      const used: string[] = [];
      if (onDashboards.has(view.id)) used.push('on a dashboard');
      if (inReports.has(view.id)) used.push('in a report');
      return [
        el('h3', { text: view.name || '(unnamed)' }),
        view.description ? el('p', { text: view.description }) : el('span', {}),
        el(
          'p',
          { class: 'muted' },
          el('span', { text: `${presentationOf(view).label}. ` }),
          el('span', { text: view.subjects.length > 0 ? `About ${[...new Set(view.subjects)].join(', ')}. ` : '' }),
          el('span', { text: used.length > 0 ? `Used ${used.join(' and ')}.` : 'Not used by any dashboard or report in this export.' }),
          view.usages.length > 0 ? el('span', { text: ` Allowed in: ${view.usages.join(', ')}.` }) : el('span', {}),
        ),
      ];
    },
    render: (view) => viewCanvas(view),
  });
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

/** What a section is called, and what it contributes to the printed report. */
const SECTION_NOTE: Readonly<Record<string, string>> = {
  CoverPage: 'The front page: title, the object it was run for, and when.',
  TableOfContents: 'A contents page, generated from the sections after it.',
  View: 'A view, printed as a table or a chart.',
  Dashboard: 'A whole dashboard, printed as it is laid out.',
};

function sectionRow(section: ReportSection, index: number, viewsById: ReadonlyMap<string, ViewDefinition>, dashboardsById: ReadonlyMap<string, Dashboard>): HTMLElement {
  const row = el('div', { class: `report-section kind-${section.contentType.toLowerCase()}` });
  append(
    row,
    el('div', { class: 'report-section-no', text: String(index + 1) }),
  );

  const body = el('div', { class: 'report-section-body' });
  append(body, el('div', { class: 'report-section-type', text: section.contentType }));

  // Only a View or Dashboard section names something that has to exist; a
  // cover page and a contents page carry a key that refers to nothing.
  if (section.contentType === 'View' && section.contentKey) {
    const view = viewsById.get(section.contentKey);
    append(
      body,
      view
        ? el('div', { class: 'report-section-name' }, el('strong', { text: view.name }), el('span', { class: 'muted', text: ` — ${view.columns.length} column${view.columns.length === 1 ? '' : 's'}` }))
        : el('div', { class: 'report-section-name is-missing', text: 'The view it prints is not in this export.' }),
    );
  } else if (section.contentType === 'Dashboard' && section.contentKey) {
    const dashboard = dashboardsById.get(section.contentKey);
    append(
      body,
      dashboard
        ? el('div', { class: 'report-section-name' }, el('strong', { text: dashboard.name }), el('span', { class: 'muted', text: ` — ${dashboard.widgets.length} widgets` }))
        : el('div', { class: 'report-section-name is-missing', text: 'The dashboard it prints is not in this export.' }),
    );
  } else {
    append(body, el('div', { class: 'muted', text: SECTION_NOTE[section.contentType] ?? 'Part of the report.' }));
  }

  if (section.orientation) {
    append(body, el('div', { class: 'muted report-section-note', text: section.orientation }));
  }

  append(row, body);
  return row;
}

export function reportViewer(reports: readonly ReportDefinition[], views: readonly ViewDefinition[], dashboards: readonly Dashboard[]): OneOfMany {
  const viewsById = new Map(views.map((view) => [view.id, view]));
  const dashboardsById = new Map(dashboards.map((dashboard) => [dashboard.id, dashboard]));

  return oneOfMany<ReportDefinition>({
    items: reports,
    noun: 'Report',
    idOf: (report) => report.id,
    sort: (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
    group: (report) => (report.scheduleCount > 0 ? 'Scheduled' : 'Never scheduled'),
    label: (report) => `${report.name || '(unnamed)'}${report.scheduleCount > 0 ? ` — ${report.scheduleCount} schedule${report.scheduleCount === 1 ? '' : 's'}` : ''}`,
    heading: (report) => [
      el('h3', { text: report.name || '(unnamed)' }),
      report.description ? el('p', { text: report.description }) : el('span', {}),
      el(
        'p',
        { class: 'muted' },
        el('span', { text: report.subjects.length > 0 ? `About ${report.subjects.join(', ')}. ` : '' }),
        report.scheduleCount > 0
          ? el('span', { text: `Runs on ${report.scheduleCount} schedule${report.scheduleCount === 1 ? '' : 's'}. ` })
          : el('strong', { text: 'No schedule — nobody receives this. ' }),
        el('span', { text: report.outputFormats.length > 0 ? `Comes out as ${report.outputFormats.join(' and ').toUpperCase()}. ` : '' }),
        report.owner ? el('span', { text: `Owner ${report.owner}.` }) : el('span', {}),
      ),
    ],
    render: (report) => {
      if (report.sections.length === 0) {
        return el(
          'div',
          { class: 'tip' },
          el('strong', { text: 'What is in this report is not in the export. ' }),
          el('span', { text: 'The API inventory lists reports and their owners; the sections are only in the content package’s reports.zip. Drop that in and this fills out.' }),
        );
      }
      const stack = el('div', { class: 'report-sections' });
      report.sections.forEach((section, index) => append(stack, sectionRow(section, index, viewsById, dashboardsById)));
      return stack;
    },
  });
}

// ---------------------------------------------------------------------------
// The tabs
// ---------------------------------------------------------------------------

export function mountViewsView(container: HTMLElement, views: readonly ViewDefinition[], dashboards: readonly Dashboard[], reports: readonly ReportDefinition[]): OneOfMany {
  const viewer = viewViewer(views, dashboards, reports);
  clear(container);
  append(container, card('View', viewer.element));
  return viewer;
}

export function mountReportsView(container: HTMLElement, reports: readonly ReportDefinition[], views: readonly ViewDefinition[], dashboards: readonly Dashboard[]): OneOfMany {
  const viewer = reportViewer(reports, views, dashboards);
  clear(container);
  append(container, card('Report', viewer.element));
  return viewer;
}
