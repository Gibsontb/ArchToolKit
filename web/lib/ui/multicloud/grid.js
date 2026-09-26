/**
 * `planGrid`: the intake grids (Servers, Databases, and the small constraint
 * lists) over `tableEditor` from multi-editors.ts, so every list on the two
 * migration pages is the same " | " grid with a dropdown per closed column.
 *
 * Around the editor it adds what a 5,000-row plan needs: filters (a dropdown
 * per chosen column and free text) applied first, then a page window of
 * 50 / 100 / 200 rows; the bulk edit bar ("Set column … to …" on every
 * filtered row); and Import CSV, Export CSV and Clear.
 *
 * Every change goes through the pane's `write`, which calls
 * `ctx.session.update`, so it is saved and reaches the other page. The grid
 * does not rebuild itself for its own edits (that would take the cursor out of
 * the cell being typed in); a value that follows from an edit (an RPO from a
 * criticality, a size from a basis) is written into its cell in place.
 */

import { el, append, clear, downloadFile, readFileAsText } from '../dom.js';
import { findingsList } from '../components.js';
import { tableEditor } from '../multi-editors.js';
                                                      
import {
  applyCells, bulkSet, columnValues, filterRows, gridText, pageOf, parseGridText, reconcilePage, rowCells,
                                   
} from './grid-model.js';

                                                                                                    

                             
                            
                                                  
                                                                                        
                                                                                                     
 

                                                  
                                               
                      
                                                    
                        
                                             
                                    
                                      
                                 
                                             
                                                                            
                                                                
                                    
                                          
                                                                         
                                        
                             
                            
                                                                        
                                                                                                                                        
                                                               
                                 
 

                           
                             
                                                                                 
                 
                                                                               
                  
                                                 
                                
 

const PAGE_SIZES = [50, 100, 200]         ;

/** Set one cell of the editor's DOM and tell the editor (it listens for input / change). */
function syncCell(tr                            , column        , text        )       {
  const td = tr?.children[column];
  const control = td?.querySelector('select, input')                                               ;
  if (!control || control.value === text) return;
  if (control instanceof HTMLSelectElement) {
    if (!Array.from(control.options).some((o) => o.value === text)) {
      control.insertBefore(el('option', { text: text || '—', attrs: { value: text } }), control.firstChild);
    }
    control.value = text;
    control.dispatchEvent(new Event('change'));
  } else {
    control.value = text;
    control.dispatchEvent(new Event('input'));
  }
}

export function planGrid                   (spec                 )           {
  const n = spec.columns.length;
  const byKey = new Map(spec.columns.map((c, i) => [c.key, i]));
  const filter                                                   = { equals: {}, text: '' };
  let page = 0;
  let size         = spec.pageSize ?? 100;
  let writing = false;
  let syncing = false;
  let pageIdx           = [];
  let pageCells             = [];
  let filteredIdx           = [];
  let editorRoot                     = null;

  const root = el('div', { class: 'stack plan-grid', attrs: { 'data-control': `${spec.id}-grid` } });
  const filterBar = el('div', { class: 'filter-row', attrs: { 'data-control': `${spec.id}-filters` } });
  const bulkBar = el('div', { class: 'filter-row', attrs: { 'data-control': `${spec.id}-bulk` } });
  const pager = el('div', { class: 'btn-row', style: { alignItems: 'center' }, attrs: { 'data-control': `${spec.id}-pager` } });
  const holder = el('div', { style: { maxWidth: '100%', overflowX: 'auto' } });
  const messages = el('div', { attrs: { role: 'status', 'data-control': `${spec.id}-grid-messages` } });
  const csvBar = el('div', { class: 'btn-row' });
  append(root, filterBar, bulkBar, pager, holder, messages, csvBar);

  const write = (rows     ) => {
    writing = true;
    try {
      spec.write(rows);
    } finally {
      writing = false;
    }
    spec.onChange?.();
  };

  const say = (lines                   , findings                     = []) => {
    clear(messages);
    if (lines.length > 0) append(messages, el('ul', { class: 'small', style: { margin: '0', paddingLeft: '1.2rem', color: 'var(--warn)' } }, ...lines.slice(0, 8).map((l) => el('li', { text: l }))));
    if (findings.length > 0) append(messages, findingsList(findings));
  };

  /** One change in the editor: its page text reconciled with the rows and written. */
  const onEditor = () => {
    if (!editorRoot) return;
    const hidden = editorRoot.querySelector                     ('textarea.multi-value');
    if (!hidden) return;
    const next = parseGridText(hidden.value, n);
    if (syncing) {
      pageCells = next;
      return;
    }
    const ops = reconcilePage(pageCells, next);
    if (ops.length === 0) {
      pageCells = next;
      return;
    }
    let rows = [...spec.read()];
    const errors           = [];
    const removed = new Set        ();
    const toSync                                                      = [];
    for (const op of ops) {
      if (op.kind === 'remove') {
        const gi = pageIdx[op.index];
        if (gi !== undefined) removed.add(gi);
        continue;
      }
      const isAdd = op.kind === 'add';
      const gi = isAdd ? rows.length : pageIdx[op.index];
      if (gi === undefined) continue;
      const before = isAdd ? spec.create(rows) : rows[gi];
      if (!before) continue;
      // A new row's blank cells keep the row's defaults (and are shown filled in below).
      const typed = isAdd ? op.cells.map((c, i) => (c === '' ? rowCells(before, spec.columns)[i] ?? '' : c)) : op.cells;
      const r = applyCells(before, spec.columns, typed);
      errors.push(...r.errors);
      const after = spec.after ? spec.after(before, r.row, rows) : r.row;
      if (isAdd) {
        rows.push(after);
        pageIdx.push(gi);
      } else {
        rows[gi] = after;
      }
      // Cells that now differ from what was typed, without an error: derived values to show.
      const shown = rowCells(after, spec.columns);
      const pageRow = isAdd ? pageIdx.length - 1 : (op                     ).index;
      shown.forEach((text, c) => {
        const typed = op.cells[c] ?? '';
        const refused = r.errors.some((e) => e.startsWith(`${spec.columns[c]?.label}`));
        if (text !== typed && !refused) toSync.push({ pageRow, column: c, text });
      });
    }
    if (removed.size > 0) {
      const keep = rows.map((_, i) => !removed.has(i));
      const remap = new Map                ();
      let k = 0;
      keep.forEach((kept, i) => {
        if (kept) remap.set(i, k++);
      });
      rows = rows.filter((_, i) => keep[i]);
      pageIdx = pageIdx.filter((gi) => !removed.has(gi)).map((gi) => remap.get(gi) ?? gi);
    }
    pageCells = next;
    write(rows);
    say(errors);
    if (toSync.length > 0) {
      const body = editorRoot.querySelector('tbody');
      syncing = true;
      try {
        for (const s of toSync) syncCell(body?.children[s.pageRow], s.column, s.text);
      } finally {
        syncing = false;
      }
      const hiddenNow = editorRoot.querySelector                     ('textarea.multi-value');
      if (hiddenNow) pageCells = parseGridText(hiddenNow.value, n);
    }
  };

  function renderFilters(rows              )       {
    clear(filterBar);
    for (const key of spec.filterKeys ?? []) {
      const i = byKey.get(key);
      const col = i === undefined ? undefined : spec.columns[i];
      if (!col) continue;
      const sel = el('select', { attrs: { 'aria-label': `Filter by ${col.label}`, 'data-control': `${spec.id}-filter-${key}` } })                     ;
      append(sel, el('option', { text: `Any ${col.label.toLowerCase()}`, attrs: { value: '' } }));
      for (const o of columnValues(rows, col)) append(sel, el('option', { text: o.label, attrs: { value: o.value } }));
      sel.value = filter.equals[key] ?? '';
      if (sel.value !== (filter.equals[key] ?? '')) filter.equals[key] = '';
      sel.addEventListener('change', () => {
        filter.equals[key] = sel.value;
        page = 0;
        render();
      });
      append(filterBar, sel);
    }
    const search = el('input', { attrs: { type: 'search', placeholder: 'Find…', 'aria-label': `Find ${spec.noun}s`, 'data-control': `${spec.id}-search` }, style: { flex: '1 1 8rem', minWidth: '0' } })                    ;
    search.value = filter.text;
    let timer                                           ;
    search.addEventListener('input', () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        filter.text = search.value;
        page = 0;
        render();
        const again = filterBar.querySelector                  ('input[type=search]');
        again?.focus();
        if (again) again.setSelectionRange(again.value.length, again.value.length);
      }, 250);
    });
    append(filterBar, search);
  }

  function renderBulk()       {
    clear(bulkBar);
    const keys = spec.bulkKeys ?? spec.columns.slice(1).map((c) => c.key);
    const cols = keys.map((k) => spec.columns[byKey.get(k) ?? -1]).filter((c)                     => !!c);
    const colSel = el('select', { attrs: { 'aria-label': 'Column to set', 'data-control': `${spec.id}-bulk-column` } })                     ;
    for (const c of cols) append(colSel, el('option', { text: `Set ${c.label}`, attrs: { value: c.key } }));
    const valueSlot = el('span', { style: { display: 'contents' } });
    let valueControl                                      ;
    const makeValue = () => {
      clear(valueSlot);
      const col = spec.columns[byKey.get(colSel.value) ?? -1];
      if (col?.options) {
        const s = el('select', { attrs: { 'aria-label': 'Value', 'data-control': `${spec.id}-bulk-value` } })                     ;
        for (const o of col.options) append(s, el('option', { text: o.label || '—', attrs: { value: o.value } }));
        valueControl = s;
      } else {
        valueControl = el('input', { attrs: { type: 'text', placeholder: 'to…', 'aria-label': 'Value', 'data-control': `${spec.id}-bulk-value` }, style: { flex: '1 1 8rem', minWidth: '0' } })                    ;
      }
      append(valueSlot, valueControl);
    };
    colSel.addEventListener('change', makeValue);
    makeValue();
    const apply = el('button', {
      class: 'btn btn-small',
      text: 'Apply to the filtered rows',
      attrs: { type: 'button', 'data-control': `${spec.id}-bulk-apply` },
      on: {
        click: () => {
          const r = bulkSet(spec.read(), filteredIdx, spec.columns, colSel.value, valueControl.value, spec.after);
          write(r.rows);
          render();
          say([`${r.changed} ${spec.noun}${r.changed === 1 ? '' : 's'} changed.`, ...r.errors]);
        },
      },
    });
    append(bulkBar, colSel, valueSlot, apply);
    for (const a of spec.actions ?? []) {
      append(bulkBar, el('button', { class: 'btn btn-small', text: a.label, attrs: { type: 'button', title: a.title ?? '' }, on: { click: () => a.run(filteredIdx) } }));
    }
  }

  function renderPager(total        , pages        )       {
    clear(pager);
    const sizeSel = el('select', { attrs: { 'aria-label': 'Rows per page', 'data-control': `${spec.id}-page-size` }, style: { width: 'auto' } })                     ;
    for (const s of PAGE_SIZES) append(sizeSel, el('option', { text: `${s} a page`, attrs: { value: String(s) } }));
    sizeSel.value = String(size);
    sizeSel.addEventListener('change', () => {
      size = Number(sizeSel.value);
      page = 0;
      render();
    });
    const prev = el('button', { class: 'btn btn-small', text: '‹ Previous', attrs: { type: 'button', disabled: page <= 0 }, on: { click: () => ((page -= 1), render()) } });
    const next = el('button', { class: 'btn btn-small', text: 'Next ›', attrs: { type: 'button', disabled: page >= pages - 1 }, on: { click: () => ((page += 1), render()) } });
    const all = spec.read().length;
    append(
      pager,
      prev,
      el('span', { class: 'small muted', text: `Page ${page + 1} of ${pages} · ${total} of ${all} ${spec.noun}${all === 1 ? '' : 's'}` }),
      next,
      sizeSel,
    );
  }

  function renderCsv()       {
    clear(csvBar);
    const csv = spec.csv;
    if (!csv) return;
    const picker = el('input', { attrs: { type: 'file', accept: '.csv,text/csv', hidden: 'hidden' } })                    ;
    picker.addEventListener('change', () => {
      const file = picker.files?.[0];
      picker.value = '';
      if (!file) return;
      void readFileAsText(file).then((text) => {
        const r = csv.import(text, spec.read());
        write(r.rows);
        render();
        say([], r.findings.length > 0 ? r.findings : []);
        if (r.findings.length === 0) say([`${file.name} imported.`]);
      });
    });
    append(
      csvBar,
      el('button', { class: 'btn btn-small', text: 'Import CSV…', attrs: { type: 'button', 'data-control': `${spec.id}-csv-import` }, on: { click: () => picker.click() } }),
      el('button', {
        class: 'btn btn-small',
        text: 'Export CSV',
        attrs: { type: 'button', 'data-control': `${spec.id}-csv-export` },
        on: { click: () => downloadFile(csv.fileName, csv.export(spec.read()), 'text/csv') },
      }),
      el('button', {
        class: 'btn btn-small btn-danger',
        text: 'Clear',
        attrs: { type: 'button', 'data-control': `${spec.id}-clear` },
        on: {
          click: () => {
            const count = spec.read().length;
            if (count === 0) return;
            if (globalThis.confirm && !globalThis.confirm(`Remove all ${count} ${spec.noun}${count === 1 ? '' : 's'} from the plan?`)) return;
            write([]);
            render();
          },
        },
      }),
      picker,
    );
  }

  function render()       {
    const rows = spec.read();
    const f             = { equals: filter.equals, text: filter.text };
    renderFilters(rows);
    filteredIdx = filterRows(rows, spec.columns, f);
    const p = pageOf(filteredIdx, page, size);
    page = p.page;
    pageIdx = [...p.indices];
    pageCells = pageIdx.map((i) => rowCells(rows[i]     , spec.columns));
    renderPager(filteredIdx.length, p.pages);
    const shape = {
      separator: ' | '         ,
      columns: spec.columns.map((c) => c.label),
      headerInValue: false,
      spaced: true,
      choices: spec.columns.map((c) => c.options),
    };
    editorRoot = tableEditor(shape, gridText(pageCells), onEditor);
    editorRoot.setAttribute('data-control', `${spec.id}-editor`);
    clear(holder);
    append(holder, editorRoot);
    spec.onChange?.();
  }

  renderBulk();
  renderCsv();
  render();
  return { root, render, busy: () => writing, filtered: () => filteredIdx };
}

// ---------------------------------------------------------------------------
// Small helpers the panes share
// ---------------------------------------------------------------------------

/**
 * Run `fn` now when `node` is on screen, else the next time it is: a hidden
 * pane does not rebuild a large grid for every edit made on another pane.
 */
export function whenShown(node             , fn            )             {
  let stale = false;
  const visible = () => node.isConnected && node.offsetParent !== null;
  const observer = typeof IntersectionObserver !== 'undefined'
    ? new IntersectionObserver((entries) => {
      if (stale && entries.some((e) => e.isIntersecting)) {
        stale = false;
        fn();
      }
    })
    : null;
  observer?.observe(node);
  return () => {
    if (visible() || !observer) fn();
    else stale = true;
  };
}

/** Pick files and read them as text. */
export function pickFiles(accept        , multiple         )                                            {
  return new Promise((resolve) => {
    const input = el('input', { attrs: { type: 'file', accept, multiple, hidden: 'hidden' } })                    ;
    input.addEventListener('change', () => {
      const files = Array.from(input.files ?? []);
      void Promise.all(files.map(async (f) => ({ name: f.name, text: await readFileAsText(f) }))).then(resolve);
    });
    document.body.appendChild(input);
    input.click();
    setTimeout(() => input.remove(), 60_000);
  });
}

/** Files dropped on `node` (a card) are read as text and handed over; the card shows it takes them. */
export function dropZone(node             , onFiles                                                   )              {
  node.addEventListener('dragover', (e) => {
    e.preventDefault();
    node.classList.add('dragging');
  });
  node.addEventListener('dragleave', () => node.classList.remove('dragging'));
  node.addEventListener('drop', (e) => {
    e.preventDefault();
    node.classList.remove('dragging');
    const files = Array.from((e             ).dataTransfer?.files ?? []);
    if (files.length === 0) return;
    void Promise.all(files.map(async (f) => ({ name: f.name, text: await readFileAsText(f) }))).then(onFiles);
  });
  return node;
}
