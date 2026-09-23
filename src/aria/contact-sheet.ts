/**
 * Every dashboard, as one HTML file you can keep.
 *
 * The viewer in the toolkit is for working; this is for everything after that
 * — sending the set to someone, reviewing three hundred of them in a meeting,
 * printing to PDF for a decommissioning decision, or simply having a record of
 * what the platform looked like before it was rebuilt.
 *
 * So it is one file with no links out: the styles are inline, there is no
 * script, and it opens on any machine with a browser and nothing installed. It
 * is also full of an estate's object names, which is said at the top of it
 * rather than left for someone to discover.
 */

import { DASHBOARD_COLUMNS, dashboardRows, widgetFamily, type Dashboard, type ViewDefinition } from './aria.ts';

/** Escape for text and for attribute values alike. */
function esc(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const FAMILY_COLOUR: Readonly<Record<string, string>> = {
  chart: '#3f6fb5',
  table: '#3d7f63',
  alert: '#b3261e',
  topology: '#7a5ba6',
  text: '#6b6b6b',
  picker: '#b8860b',
  other: '#8a8a8a',
};

function widgetHtml(dashboard: Dashboard, viewNames: ReadonlyMap<string, string>): string {
  const ordered = [...dashboard.widgets].sort((a, b) => a.y - b.y || a.x - b.x);
  let viewIndex = 0;
  const parts: string[] = [];

  for (const widget of ordered) {
    const family = widgetFamily(widget.type);
    const column = Math.min(Math.max(widget.x, 1), DASHBOARD_COLUMNS);
    const span = Math.min(Math.max(widget.w, 1), DASHBOARD_COLUMNS - column + 1);
    const rowSpan = Math.max(widget.collapsed ? 1 : widget.h, 1);

    let extra = '';
    if (widget.type === 'View') {
      const viewId = dashboard.viewIds[viewIndex];
      viewIndex += 1;
      const name = viewId ? viewNames.get(viewId) : undefined;
      if (name && name !== widget.title) extra = `<div class="v">shows: ${esc(name)}</div>`;
      else if (viewId && !name) extra = '<div class="v missing">the view it shows is not in this export</div>';
    }

    parts.push(
      `<div class="w" style="grid-column:${column} / span ${span};grid-row:${Math.max(widget.y, 1)} / span ${rowSpan};border-left-color:${FAMILY_COLOUR[family]}">` +
        `<div class="t">${esc(widget.type)}</div><div class="n">${esc(widget.title || '(untitled)')}</div>${extra}` +
        `</div>`,
    );
  }
  return parts.join('');
}

function dashboardHtml(dashboard: Dashboard, viewNames: ReadonlyMap<string, string>, index: number): string {
  const kinds = [...new Set(dashboard.widgets.map((widget) => widget.type))];
  const rows = Math.max(dashboardRows(dashboard), 1);
  const created = dashboard.created ? ` · created ${new Date(dashboard.created).toISOString().slice(0, 10)}` : '';

  const body =
    dashboard.widgets.length === 0
      ? '<p class="empty">This dashboard has no widgets on it.</p>'
      : `<div class="canvas" style="grid-template-columns:repeat(${DASHBOARD_COLUMNS},minmax(0,1fr));min-height:${rows * 20}px">${widgetHtml(dashboard, viewNames)}</div>`;

  return `<section class="dash" id="d${index}">
  <h2>${esc(dashboard.name || '(unnamed)')}</h2>
  <p class="meta">${dashboard.shared ? 'Shared' : 'Not shared — lives in one account'} · ${dashboard.widgets.length} widget${dashboard.widgets.length === 1 ? '' : 's'}${created}</p>
  <p class="kinds">${esc(kinds.join(', ')) || '—'}</p>
  ${body}
</section>`;
}

/**
 * The whole set as one self-contained page.
 *
 * `@media print` gives each dashboard its own page, because the reason to print
 * this is to put it in front of people who are deciding what to keep.
 */
export function dashboardSheet(dashboards: readonly Dashboard[], views: readonly ViewDefinition[]): string {
  const viewNames = new Map(views.map((view) => [view.id, view.name]));
  const ordered = [...dashboards].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  const made = new Date().toISOString().slice(0, 10);

  const contents = ordered
    .map((dashboard, index) => `<li><a href="#d${index}">${esc(dashboard.name || '(unnamed)')}</a> <span class="muted">${dashboard.widgets.length}${dashboard.shared ? '' : ' · private'}</span></li>`)
    .join('');

  const key = Object.entries(FAMILY_COLOUR)
    .map(([family, colour]) => `<span class="k" style="border-left-color:${colour}">${family}</span>`)
    .join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Aria Operations dashboards</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 2rem; font: 14px/1.5 -apple-system, "Segoe UI", system-ui, sans-serif; color: #1b1b1b; background: #fbfbfb; }
  h1 { font-size: 1.5rem; margin: 0 0 .25rem; }
  h2 { font-size: 1.05rem; margin: 0 0 .2rem; }
  .lede { color: #555; max-width: 60rem; margin: 0 0 1.5rem; }
  .warn { border: 1px solid #b3261e; border-left-width: 4px; background: #fff5f4; padding: .75rem 1rem; border-radius: 4px; margin: 0 0 2rem; max-width: 60rem; }
  .toc { columns: 3; column-gap: 2rem; list-style: none; padding: 0; margin: 0 0 2.5rem; font-size: .85rem; }
  .toc li { break-inside: avoid; margin-bottom: .15rem; }
  .toc a { color: #24457a; text-decoration: none; }
  .toc a:hover { text-decoration: underline; }
  .muted { color: #777; }
  .keys { margin: 0 0 2rem; font-size: .75rem; }
  .k { display: inline-block; border-left: 4px solid; padding: .1rem .5rem; margin-right: .5rem; background: #fff; border-radius: 2px; }
  .dash { background: #fff; border: 1px solid #e0e0e0; border-radius: 6px; padding: 1.25rem; margin: 0 0 1.5rem; break-inside: avoid; }
  .meta, .kinds { color: #666; font-size: .8rem; margin: 0 0 .15rem; }
  .kinds { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .72rem; margin-bottom: .9rem; }
  .canvas { display: grid; grid-auto-rows: 20px; gap: 3px; }
  .w { border: 1px solid #e2e2e2; border-left: 4px solid #8a8a8a; border-radius: 3px; background: #fafafa; padding: .2rem .4rem; overflow: hidden; min-width: 0; }
  .t { font-size: .6rem; letter-spacing: .04em; text-transform: uppercase; color: #8a8a8a; }
  .n { font-size: .75rem; font-weight: 600; overflow: hidden; text-overflow: ellipsis; }
  .v { font-size: .68rem; color: #666; font-style: italic; }
  .v.missing { color: #b3261e; font-style: normal; }
  .empty { color: #777; font-style: italic; }
  footer { color: #777; font-size: .78rem; margin-top: 2rem; }
  @media print {
    body { padding: 0; background: #fff; }
    .toc, .keys { break-after: page; }
    .dash { break-inside: avoid; page-break-inside: avoid; border: 0; padding: 0 0 1rem; }
  }
</style>
</head>
<body>
<h1>Aria Operations dashboards</h1>
<p class="lede">${ordered.length} dashboard${ordered.length === 1 ? '' : 's'}, drawn from the content export as they were arranged: twelve columns, every widget in its own place. The widgets are labelled boxes rather than live charts — the data is not in an export, only the layout is. Drawn ${made} by ArchToolKit.</p>
<div class="warn"><strong>This file describes a production estate.</strong> Dashboard and widget names, and the views they show, come straight from the appliance. Treat it like the export it was made from: not in a repository, not attached to a ticket.</div>
<div class="keys">${key}</div>
<ol class="toc">${contents}</ol>
${ordered.map((dashboard, index) => dashboardHtml(dashboard, viewNames, index)).join('\n')}
<footer>ArchToolKit · all rights reserved · Theodore Gibson</footer>
</body>
</html>
`;
}
