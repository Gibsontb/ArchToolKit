import { el, replace, downloadFile } from './dom.js';
import { field, select, table } from './components.js';
export function inventoryTableView(root             , title        , headers                   , rows                                )       {
  let page = 0;
  const search = el('input', { attrs: { type: 'search', placeholder: 'Search all columns', 'aria-label': 'Search ' + title } });
  const vcenterColumn = headers.findIndex(value => /^(vcenter|vi sdk server)$/i.test(value));
  const vcenters = vcenterColumn < 0 ? [] : [...new Set(rows.map(row => row[vcenterColumn] ?? '').filter(Boolean))].sort();
  const scope = select([{ value: '', label: 'All vCenters' }, ...vcenters.map(value => ({ value, label: value }))], '');
  const size = select(['25','50','100','250'].map(value => ({ value, label: value })), '50');
  const display = el('div');
  const indexed = rows.map(row => row.join(' ').toLowerCase());
  const filtered = () => rows.filter((row, index) => (!scope.value || row[vcenterColumn] === scope.value) && indexed[index] .includes(search.value.toLowerCase()));
  function draw()       {
    const matches = filtered(); const count = Number(size.value);
    const last = Math.max(0, Math.ceil(matches.length / count) - 1); page = Math.min(page, last);
    const previous = el('button', { class: 'btn', text: 'Previous', attrs: { type: 'button', disabled: page === 0 }, on: { click: () => { page--; draw(); } } });
    const next = el('button', { class: 'btn', text: 'Next', attrs: { type: 'button', disabled: page === last }, on: { click: () => { page++; draw(); } } });
    replace(display, el('p', { text: matches.length.toLocaleString() + ' matching / ' + rows.length.toLocaleString() + ' total rows · Page ' + (page + 1) + ' of ' + (last + 1) }),
      matches.length ? table(headers.map((header, index) => ({ header, render: (row                   ) => row[index] || '—' })), matches.slice(page * count, (page + 1) * count)) : el('p', { text: 'No matching rows.' }),
      el('div', { class: 'btn-row' }, previous, next));
  }
  const exportButton = el('button', { class: 'btn', text: 'Download filtered CSV', attrs: { type: 'button' }, on: { click: () => {
    const cell = (value        ) => '"' + (/^[\s=+@-]/.test(value) ? "'" + value : value).replace(/"/g, '""') + '"';
    downloadFile(title.replace(/[^a-z0-9-]/gi, '-') + '.csv', [headers, ...filtered()].map(row => row.map(value => cell(value)).join(',')).join('\r\n'), 'text/csv');
  } } });
  search.addEventListener('input', () => { page = 0; draw(); });
  for (const input of [scope, size]) input.addEventListener('change', () => { page = 0; draw(); });
  replace(root, el('div', { class: 'field-grid' }, field('Search', search), vcenters.length ? field('vCenter', scope) : null, field('Rows per page', size)), exportButton, display);
  draw();
}
