/**
 * Fields that hold several things, edited one thing at a time.
 *
 * A comma-separated list becomes chips with an Add box; rows of columns (the
 * " | " tables and CSV samples blueprints take) become a grid with a header,
 * one input per cell and Add row; everything else multi-line grows as it is
 * typed into. Each editor keeps the value in the exact text format the
 * blueprint reads, in a hidden field (class `multi-value`) the page reads like
 * any other, so no blueprint changes to use them.
 */

import { el, replace } from './dom.js';
                                                                        

// --- deciding which editor a field gets ---------------------------------------

const LIST_DEFAULT = /^[^,\s|]+(,\s?[^,\s|]+)+$/;

/** A single-line field that holds a comma-separated list. */
export function isListField(input                )          {
  if (input.control !== 'text' && input.control !== 'combo') return false;
  if (input.control === 'combo') return false;
  const d = String(input.default ?? '');
  // A distinguished name (CN=…,OU=…) or a key=value string has commas in one value.
  if (/=/.test(d) || /(^|_)(dn|base_dn|filter|query)(_|$)/i.test(input.id)) return false;
  return /comma[- ]separated|comma or space separated|, one per|a list of/i.test(`${input.hint ?? ''} ${input.help ?? ''}`) || LIST_DEFAULT.test(String(input.default ?? '').trim());
}

                      
                                  
                                      
                                                  
                                  
     
                                                                               
                                                              
     
                            
                                                                               
                                                                      
 

const columnName = (hintPart        )         => hintPart.replace(/\s*(\(|—).*$/, '').trim();

/** The cells of a row: on "|", or in a spaced table only on " | ". */
function splitCells(line        , shape                                          )           {
  if (shape.separator === ',') return line.split(',');
  return shape.spaced ? ` ${line} `.split(/(?<=\s)\|(?=\s)/) : line.split('|');
}

/** Rows of columns: a " | " table whose hint names the columns, or a CSV whose first line does. */
export function tableShape(input                )                         {
  if (input.control !== 'textarea') return undefined;
  const lines = String(input.default ?? '').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  const first = lines[0] ?? '';
  if (/^[a-z_][a-z0-9_]*(,[a-z_][a-z0-9_]*)+$/i.test(first)) return { separator: ',', columns: first.split(','), headerInValue: true };
  const hint = input.hint ?? '';
  const named = hint.split('|').map((h) => h.trim()).filter(Boolean);
  // A textarea that brings options is a grid by declaration: its cells split on
  // " | " only, and an option whose group names a column is offered in that
  // column's dropdown. Textareas without options are read as before.
  if ((input.options?.length ?? 0) > 0 && named.length >= 2 && hint.includes(' | ')) {
    const columns = named.map(columnName);
    const choices = columns.map((column) => {
      const offered = (input.options ?? []).filter((option) => option.group === column);
      return offered.length > 0 ? offered : undefined;
    });
    return { separator: ' | ', columns, headerInValue: false, spaced: true, choices };
  }
  // A table only when the hint names every column and the rows use the same separator: SPL and scripts that happen to contain a pipe stay text.
  if (named.length >= 2 && hint.includes(' | ') && lines.length > 0 && lines.every((l) => l.split('|').length === named.length) && !first.startsWith('|')) {
    return { separator: ' | ', columns: named.map(columnName), headerInValue: false };
  }
  return undefined;
}

// --- the editors -------------------------------------------------------------------

const store = (value        )                      => {
  const node = el('textarea', { class: 'multi-value', attrs: { hidden: true } })                       ;
  node.value = value;
  return node;
};

/** Chips for a comma-separated list; Add, Enter, a comma or leaving the box adds what was typed. */
export function listEditor(input                , value        , onChange            )              {
  let items = value.split(',').map((v) => v.trim()).filter(Boolean);
  const hidden = store(items.join(', '));
  const chips = el('div', { class: 'tag-chips multi-chips' });
  const box = el('input', { class: 'multi-input', attrs: { type: 'text', placeholder: input.placeholder ?? `Add ${input.label.toLowerCase().replace(/s$/, '')}`, 'aria-label': `Add to ${input.label}` } })                    ;
  const root = el('div', { class: 'list-editor' }, chips, el('div', { class: 'tag-add-row' }, box, el('button', { class: 'btn btn-small', text: 'Add', attrs: { type: 'button' }, on: { mousedown: (e       ) => e.preventDefault(), click: () => add(true) } })), hidden);

  const commit = ()       => {
    hidden.value = items.join(', ');
    onChange();
    render();
  };
  function add(refocus         )       {
    const parts = box.value.split(',').map((p) => p.trim()).filter(Boolean);
    box.value = '';
    const fresh = parts.filter((p, i) => !items.includes(p) && parts.indexOf(p) === i);
    if (fresh.length === 0) return;
    items = [...items, ...fresh];
    commit();
    if (refocus) box.focus();
  }
  function render()       {
    replace(
      chips,
      ...items.map((item) =>
        el(
          'span',
          { class: 'tag-chip' },
          el('span', { text: item }),
          el('button', {
            class: 'tag-chip-x',
            text: '×',
            attrs: { type: 'button', title: `Remove ${item}`, 'aria-label': `Remove ${item}` },
            on: {
              click: () => {
                items = items.filter((x) => x !== item);
                commit();
              },
            },
          }),
        ),
      ),
    );
    if (items.length === 0) chips.appendChild(el('span', { class: 'muted', text: 'None yet.' }));
  }
  box.addEventListener('keydown', (e) => {
    if ((e                 ).key === 'Enter') {
      e.preventDefault();
      add(true);
    }
  });
  box.addEventListener('input', () => {
    if (box.value.includes(',')) add(true);
  });
  box.addEventListener('change', () => {
    if (box.value.trim()) setTimeout(() => add(false), 0);
  });
  render();
  return root;
}

/** A grid for rows of columns, with Add row, × per row, and Edit as text for pasting in bulk. */
export function tableEditor(shape            , value        , onChange            )              {
  const lines = value.split('\n');
  const comments = lines.filter((l) => l.trim().startsWith('#'));
  const split = (line        )           => {
    const cells = splitCells(line, shape);
    return shape.columns.map((_, i) => (cells[i] ?? '').trim());
  };
  // What would end a cell is taken out of it: a comma in a CSV, a pipe in a
  // table — or, in a spaced table, only a pipe with spaces round it.
  const clean = (cell        )         => (shape.separator === ',' ? cell.replace(/[,\n]/g, ' ') : shape.spaced ? cell.replace(/\n/g, ' ').replace(/\s+\|\s+/g, '|') : cell.replace(/[|\n]/g, ' ')).trim();
  let rows = lines.map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).map(split);
  if (shape.headerInValue) rows = rows.slice(1);
  let asText = false;

  const hidden = store(value);
  const body = el('div', { class: 'table-editor-body' });
  const root = el('div', { class: 'table-editor' }, body, hidden);

  const serialize = ()         => {
    const kept = rows.filter((r) => r.some((c) => c.trim() !== ''));
    const joined = kept.map((r) => r.map(clean).join(shape.separator));
    return [...comments, ...(shape.headerInValue ? [shape.columns.join(',')] : []), ...joined].join('\n');
  };
  const commit = ()       => {
    hidden.value = serialize();
    onChange();
  };

  function render()       {
    if (asText) {
      const area = el('textarea', { class: 'autogrow', attrs: { spellcheck: 'false', rows: String(Math.max(4, rows.length + comments.length + 2)) } })                       ;
      area.value = serialize();
      area.addEventListener('input', () => {
        hidden.value = area.value;
        onChange();
      });
      replace(
        body,
        area,
        el('div', { class: 'btn-row' }, el('button', {
          class: 'btn btn-small',
          text: 'Back to the grid',
          attrs: { type: 'button' },
          on: {
            click: () => {
              const ls = area.value.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
              rows = (shape.headerInValue ? ls.slice(1) : ls).map(split);
              asText = false;
              commit();
              render();
            },
          },
        })),
      );
      return;
    }
    const head = el('tr', {}, ...shape.columns.map((c) => el('th', { text: c })), el('th', { text: '' }));
    const tbody = el('tbody');
    rows.forEach((row, r) => {
      const tr = el('tr');
      row.forEach((cell, c) => {
        const label = `${shape.columns[c]} row ${r + 1}`;
        const offered = shape.choices?.[c];
        if (offered) {
          // A dropdown; a value it does not offer (typed as text) stays, so nothing is lost.
          const select = el('select', { attrs: { 'aria-label': label } })                     ;
          const options = offered.some((o) => o.value === cell) ? offered : [{ value: cell, label: cell || '—' }, ...offered];
          for (const option of options) {
            const opt = el('option', { text: option.label, attrs: { value: option.value } })                     ;
            if (option.value === cell) opt.selected = true;
            select.appendChild(opt);
          }
          select.addEventListener('change', () => {
            rows[r] [c] = select.value;
            commit();
          });
          tr.appendChild(el('td', {}, select));
          return;
        }
        const inp = el('input', { attrs: { type: 'text', 'aria-label': label } })                    ;
        inp.value = cell;
        inp.addEventListener('input', () => {
          rows[r] [c] = inp.value;
          commit();
        });
        tr.appendChild(el('td', {}, inp));
      });
      tr.appendChild(
        el('td', { class: 'table-editor-x' }, el('button', {
          class: 'tag-cat-x',
          text: '×',
          attrs: { type: 'button', title: 'Remove this row', 'aria-label': `Remove row ${r + 1}` },
          on: {
            click: () => {
              rows = rows.filter((_, i) => i !== r);
              commit();
              render();
            },
          },
        })),
      );
      tbody.appendChild(tr);
    });
    replace(
      body,
      el('div', { class: 'table-wrap' }, el('table', { class: 'data-table table-editor-grid' }, el('thead', {}, head), tbody)),
      el(
        'div',
        { class: 'btn-row' },
        el('button', {
          class: 'btn btn-small',
          text: 'Add row',
          attrs: { type: 'button' },
          on: {
            click: () => {
              rows = [...rows, shape.columns.map(() => '')];
              render();
              (tbody.lastElementChild?.querySelector('input')                           )?.focus();
            },
          },
        }),
        el('button', { class: 'btn btn-small', text: 'Edit as text', attrs: { type: 'button', title: 'For pasting many rows at once' }, on: { click: () => ((asText = true), render()) } }),
      ),
    );
  }
  render();
  return root;
}

/** A multi-line box that grows with what is typed into it, so nothing hides behind a scroll bar. */
export function autogrow(area                     )                      {
  area.classList.add('autogrow');
  const fit = ()       => {
    area.style.height = 'auto';
    area.style.height = `${Math.min(area.scrollHeight + 2, 640)}px`;
  };
  area.addEventListener('input', fit);
  // Once it is in the page, size it to what it already holds.
  requestAnimationFrame(fit);
  return area;
}
