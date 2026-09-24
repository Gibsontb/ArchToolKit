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

import { el, replace } from './dom.ts';
import type { BlueprintInput } from '../kit/blueprint.ts';

// --- deciding which editor a field gets ---------------------------------------

const LIST_DEFAULT = /^[^,\s|]+(,\s?[^,\s|]+)+$/;

/** A single-line field that holds a comma-separated list. */
export function isListField(input: BlueprintInput): boolean {
  if (input.control !== 'text' && input.control !== 'combo') return false;
  if (input.control === 'combo') return false;
  const d = String(input.default ?? '');
  // A distinguished name (CN=…,OU=…) or a key=value string has commas in one value.
  if (/=/.test(d) || /(^|_)(dn|base_dn|filter|query)(_|$)/i.test(input.id)) return false;
  return /comma[- ]separated|comma or space separated|, one per|a list of/i.test(`${input.hint ?? ''} ${input.help ?? ''}`) || LIST_DEFAULT.test(String(input.default ?? '').trim());
}

interface TableShape {
  readonly separator: ' | ' | ',';
  readonly columns: readonly string[];
  /** The CSV header line is part of the value. */
  readonly headerInValue: boolean;
}

/** Rows of columns: a " | " table whose hint names the columns, or a CSV whose first line does. */
export function tableShape(input: BlueprintInput): TableShape | undefined {
  if (input.control !== 'textarea') return undefined;
  const lines = String(input.default ?? '').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  const first = lines[0] ?? '';
  if (/^[a-z_][a-z0-9_]*(,[a-z_][a-z0-9_]*)+$/i.test(first)) return { separator: ',', columns: first.split(','), headerInValue: true };
  const hint = input.hint ?? '';
  const named = hint.split('|').map((h) => h.trim()).filter(Boolean);
  // A table only when the hint names every column and the rows use the same separator: SPL and scripts that happen to contain a pipe stay text.
  if (named.length >= 2 && hint.includes(' | ') && lines.length > 0 && lines.every((l) => l.split('|').length === named.length) && !first.startsWith('|')) {
    return { separator: ' | ', columns: named.map((n) => n.replace(/\s*(\(|—).*$/, '').trim()), headerInValue: false };
  }
  return undefined;
}

// --- the editors -------------------------------------------------------------------

const store = (value: string): HTMLTextAreaElement => {
  const node = el('textarea', { class: 'multi-value', attrs: { hidden: true } }) as HTMLTextAreaElement;
  node.value = value;
  return node;
};

/** Chips for a comma-separated list; Add, Enter, a comma or leaving the box adds what was typed. */
export function listEditor(input: BlueprintInput, value: string, onChange: () => void): HTMLElement {
  let items = value.split(',').map((v) => v.trim()).filter(Boolean);
  const hidden = store(items.join(', '));
  const chips = el('div', { class: 'tag-chips multi-chips' });
  const box = el('input', { class: 'multi-input', attrs: { type: 'text', placeholder: input.placeholder ?? `Add ${input.label.toLowerCase().replace(/s$/, '')}`, 'aria-label': `Add to ${input.label}` } }) as HTMLInputElement;
  const root = el('div', { class: 'list-editor' }, chips, el('div', { class: 'tag-add-row' }, box, el('button', { class: 'btn btn-small', text: 'Add', attrs: { type: 'button' }, on: { mousedown: (e: Event) => e.preventDefault(), click: () => add(true) } })), hidden);

  const commit = (): void => {
    hidden.value = items.join(', ');
    onChange();
    render();
  };
  function add(refocus: boolean): void {
    const parts = box.value.split(',').map((p) => p.trim()).filter(Boolean);
    box.value = '';
    const fresh = parts.filter((p, i) => !items.includes(p) && parts.indexOf(p) === i);
    if (fresh.length === 0) return;
    items = [...items, ...fresh];
    commit();
    if (refocus) box.focus();
  }
  function render(): void {
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
    if ((e as KeyboardEvent).key === 'Enter') {
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
export function tableEditor(shape: TableShape, value: string, onChange: () => void): HTMLElement {
  const lines = value.split('\n');
  const comments = lines.filter((l) => l.trim().startsWith('#'));
  const split = (line: string): string[] => {
    const cells = shape.separator === ',' ? line.split(',') : line.split('|');
    return shape.columns.map((_, i) => (cells[i] ?? '').trim());
  };
  let rows = lines.map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).map(split);
  if (shape.headerInValue) rows = rows.slice(1);
  let asText = false;

  const hidden = store(value);
  const body = el('div', { class: 'table-editor-body' });
  const root = el('div', { class: 'table-editor' }, body, hidden);

  const serialize = (): string => {
    const kept = rows.filter((r) => r.some((c) => c.trim() !== ''));
    const joined = kept.map((r) => r.map((c) => c.replace(shape.separator === ',' ? /[,\n]/g : /[|\n]/g, ' ').trim()).join(shape.separator));
    return [...comments, ...(shape.headerInValue ? [shape.columns.join(',')] : []), ...joined].join('\n');
  };
  const commit = (): void => {
    hidden.value = serialize();
    onChange();
  };

  function render(): void {
    if (asText) {
      const area = el('textarea', { class: 'autogrow', attrs: { spellcheck: 'false', rows: String(Math.max(4, rows.length + comments.length + 2)) } }) as HTMLTextAreaElement;
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
        const inp = el('input', { attrs: { type: 'text', 'aria-label': `${shape.columns[c]} row ${r + 1}` } }) as HTMLInputElement;
        inp.value = cell;
        inp.addEventListener('input', () => {
          rows[r]![c] = inp.value;
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
              (tbody.lastElementChild?.querySelector('input') as HTMLInputElement | null)?.focus();
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
export function autogrow(area: HTMLTextAreaElement): HTMLTextAreaElement {
  area.classList.add('autogrow');
  const fit = (): void => {
    area.style.height = 'auto';
    area.style.height = `${Math.min(area.scrollHeight + 2, 640)}px`;
  };
  area.addEventListener('input', fit);
  // Once it is in the page, size it to what it already holds.
  requestAnimationFrame(fit);
  return area;
}
