/**
 * The tag list, built one entry at a time.
 *
 * An entry is some items of one object type and the tags they get: pick the
 * type, add the items (app01, app02), add one or a few tags (Environment:
 * prod, Application: payments), then Add to tag list. The form clears for the
 * next entry. The list starts empty.
 *
 * The categories and tags are worked out from the entries, so nothing is
 * created that is not attached to something, and Generate writes both the
 * catalogue and the assignments. The value is the standard in the line format
 * the tag blueprints read, followed by the entries as '@' lines.
 */

import { el, replace } from './dom.ts';
import {
  TAG_OBJECT_TYPES,
  TAG_PRESETS,
  categoriesFromEntries,
  parseTagEntries,
  rememberTagStandard,
  serializeTagList,
  type TagEntry,
} from '../kit/tag-standard.ts';

const typeLabel = (value: string): string => TAG_OBJECT_TYPES.find((t) => t.value === value)?.label ?? value;
const same = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();
const OTHER = '__other__';

interface Draft {
  type: string;
  items: string[];
  tags: { category: string; tag: string }[];
  category: string;
}

const blank = (type = 'VirtualMachine'): Draft => ({ type, items: [], tags: [], category: '' });

/**
 * A builder whose value is the tag list. The element carries a hidden textarea
 * (class `tag-standard-value`) holding it, so the page reads it like any other
 * field. A value with categories and no entries (an older standard) is left as
 * it is until the first entry is added.
 */
export function tagStandardBuilder(value: string, onChange: () => void, onStructure: () => void = () => {}): HTMLElement {
  let entries: TagEntry[] = parseTagEntries(value);
  let draft = blank();
  let editing = -1;
  let message = '';

  const store = el('textarea', { class: 'tag-standard-value', attrs: { hidden: true } }) as HTMLTextAreaElement;
  store.value = entries.length > 0 ? serializeTagList(entries) : value;
  const editor = el('div', { class: 'tag-editor' });
  const list = el('div', { class: 'tag-list' });
  const root = el(
    'div',
    { class: 'tag-builder' },
    el('p', {
      class: 'tag-intro',
      text: 'Pick what kind of object, add the items, give them one or a few tags, then Add to tag list. The form clears for the next one. The categories and tags are worked out from what you add; Generate creates them and puts each tag on its items.',
    }),
    editor,
    list,
    store,
  );

  const commit = (): void => {
    store.value = serializeTagList(entries);
    rememberTagStandard(store.value);
    onChange();
    onStructure();
  };

  /** Categories to offer: the ones already in the list, then the common ones. */
  const categoryNames = (): string[] => {
    const used = categoriesFromEntries(entries).map((c) => c.name);
    return [...used, ...TAG_PRESETS.map((p) => p.name).filter((n) => !used.some((u) => same(u, n)))];
  };
  /** Tags to offer for a category: the ones used so far, then its common ones. */
  const tagNames = (category: string): string[] => {
    const used = categoriesFromEntries(entries).find((c) => same(c.name, category))?.values ?? [];
    const common = TAG_PRESETS.find((p) => same(p.name, category))?.values ?? [];
    return [...used, ...common.filter((v) => !used.some((u) => same(u, v)))];
  };

  function renderEditor(): void {
    const d = draft;
    const redraw = (): void => {
      message = '';
      renderEditor();
    };

    // 1. What kind of object.
    const type = el('select', { attrs: { 'aria-label': 'Object type' } }) as HTMLSelectElement;
    for (const t of TAG_OBJECT_TYPES) {
      const opt = el('option', { text: t.label, attrs: { value: t.value } }) as HTMLOptionElement;
      if (t.value === d.type) opt.selected = true;
      type.appendChild(opt);
    }
    type.addEventListener('change', () => {
      draft.type = type.value;
      redraw();
    });

    // 2. The items.
    const items = el('div', { class: 'tag-chips' });
    for (const item of d.items) {
      items.appendChild(
        el(
          'span',
          { class: 'tag-chip' },
          el('span', { text: item }),
          el('button', { class: 'tag-chip-x', text: '×', attrs: { type: 'button', title: `Remove ${item}`, 'aria-label': `Remove ${item}` }, on: { click: () => ((draft.items = draft.items.filter((x) => x !== item)), redraw()) } }),
        ),
      );
    }
    const itemBox = el('input', { class: 'tag-item-input', attrs: { type: 'text', placeholder: `${typeLabel(d.type)} name, e.g. ${d.type === 'VirtualMachine' ? 'app01' : d.type === 'HostSystem' ? 'esx01' : 'name'}`, 'aria-label': 'Item name' } }) as HTMLInputElement;
    const addItems = (refocus: boolean): void => {
      const parts = itemBox.value.split(',').map((p) => p.trim()).filter(Boolean);
      itemBox.value = '';
      const fresh = parts.filter((p, i) => !draft.items.some((x) => same(x, p)) && parts.findIndex((q) => same(q, p)) === i);
      if (fresh.length === 0) return;
      draft.items = [...draft.items, ...fresh];
      redraw();
      if (refocus) (editor.querySelector('.tag-item-input') as HTMLInputElement | null)?.focus();
    };
    itemBox.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key === 'Enter') {
        e.preventDefault();
        addItems(true);
      }
    });
    itemBox.addEventListener('input', () => {
      if (itemBox.value.includes(',')) addItems(true);
    });
    itemBox.addEventListener('change', () => {
      if (itemBox.value.trim()) setTimeout(() => addItems(false), 0);
    });

    // 3. The tags: a category, then one of its tags.
    const tags = el('div', { class: 'tag-chips' });
    for (const t of d.tags) {
      tags.appendChild(
        el(
          'span',
          { class: 'tag-chip' },
          el('span', { text: `${t.category}: ${t.tag}` }),
          el('button', { class: 'tag-chip-x', text: '×', attrs: { type: 'button', title: 'Remove', 'aria-label': `Remove ${t.category} ${t.tag}` }, on: { click: () => ((draft.tags = draft.tags.filter((x) => x !== t)), redraw()) } }),
        ),
      );
    }
    const catSelect = el('select', { attrs: { 'aria-label': 'Category' } }) as HTMLSelectElement;
    catSelect.appendChild(el('option', { text: 'Category…', attrs: { value: '' } }));
    for (const n of categoryNames()) {
      const opt = el('option', { text: n, attrs: { value: n } }) as HTMLOptionElement;
      if (same(n, d.category)) opt.selected = true;
      catSelect.appendChild(opt);
    }
    const catIsOther = d.category !== '' && !categoryNames().some((n) => same(n, d.category));
    const otherOpt = el('option', { text: 'New category…', attrs: { value: OTHER } }) as HTMLOptionElement;
    if (catIsOther) otherOpt.selected = true;
    catSelect.appendChild(otherOpt);
    const catOther = el('input', { attrs: { type: 'text', placeholder: 'Category name', 'aria-label': 'New category name' } }) as HTMLInputElement;
    catOther.value = catIsOther ? d.category : '';
    catOther.hidden = !catIsOther;
    catSelect.addEventListener('change', () => {
      if (catSelect.value === OTHER) {
        catOther.hidden = false;
        catOther.focus();
        draft.category = catOther.value;
      } else {
        draft.category = catSelect.value;
        redraw();
      }
    });
    catOther.addEventListener('input', () => (draft.category = catOther.value));
    catOther.addEventListener('change', () => redraw());

    const tagSelect = el('select', { attrs: { 'aria-label': 'Tag' } }) as HTMLSelectElement;
    tagSelect.appendChild(el('option', { text: d.category ? 'Tag…' : 'Pick a category first', attrs: { value: '' } }));
    for (const v of d.category ? tagNames(d.category) : []) tagSelect.appendChild(el('option', { text: v, attrs: { value: v } }));
    if (d.category) tagSelect.appendChild(el('option', { text: 'New tag…', attrs: { value: OTHER } }));
    tagSelect.disabled = !d.category;
    const tagOther = el('input', { attrs: { type: 'text', placeholder: 'Tag', 'aria-label': 'New tag' } }) as HTMLInputElement;
    tagOther.hidden = true;
    const addTag = (): void => {
      const category = draft.category.trim();
      const tag = (tagSelect.value === OTHER ? tagOther.value : tagSelect.value).trim();
      if (!category || !tag) {
        message = !category ? 'Pick a category.' : 'Pick or type a tag.';
        renderEditor();
        return;
      }
      if (!draft.tags.some((t) => same(t.category, category) && same(t.tag, tag))) draft.tags = [...draft.tags, { category, tag }];
      redraw();
    };
    tagSelect.addEventListener('change', () => {
      if (tagSelect.value === OTHER) {
        tagOther.hidden = false;
        tagOther.focus();
      } else if (tagSelect.value) addTag();
    });
    tagOther.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key === 'Enter') {
        e.preventDefault();
        addTag();
      }
    });
    const addTagButton = el('button', { class: 'btn btn-small', text: 'Add tag', attrs: { type: 'button' }, on: { mousedown: (e: Event) => e.preventDefault(), click: addTag } });

    const addEntry = (): void => {
      if (itemBox.value.trim()) addItems(false);
      const problem = draft.items.length === 0 ? 'Add at least one item.' : draft.tags.length === 0 ? 'Give it at least one tag.' : '';
      if (problem) {
        message = problem;
        renderEditor();
        return;
      }
      const entry: TagEntry = { type: draft.type, items: [...draft.items], tags: [...draft.tags] };
      entries = editing >= 0 ? entries.map((e, i) => (i === editing ? entry : e)) : [...entries, entry];
      message = `Added ${entry.items.length} item${entry.items.length === 1 ? '' : 's'} with ${entry.tags.length} tag${entry.tags.length === 1 ? '' : 's'}.`;
      editing = -1;
      // The next entry is usually the same kind of object.
      draft = blank(entry.type);
      commit();
      render();
      (editor.querySelector('.tag-item-input') as HTMLInputElement | null)?.focus();
    };

    const field = (label: string, ...nodes: HTMLElement[]): HTMLElement => el('div', { class: 'tag-editor-field' }, el('div', { class: 'tag-editor-label', text: label }), ...nodes);

    replace(
      editor,
      el('div', { class: 'tag-editor-head' }, el('strong', { text: editing >= 0 ? `Editing entry ${editing + 1}` : 'New entry' })),
      el(
        'div',
        { class: 'tag-editor-grid' },
        field('1. Object type', type),
        field('2. Items', items, el('div', { class: 'tag-add-row' }, itemBox, el('button', { class: 'btn btn-small', text: 'Add item', attrs: { type: 'button' }, on: { mousedown: (e: Event) => e.preventDefault(), click: () => addItems(true) } }))),
        field('3. Tags', tags, el('div', { class: 'tag-add-row' }, catSelect, catOther, tagSelect, tagOther, addTagButton)),
      ),
      el(
        'div',
        { class: 'btn-row tag-editor-actions' },
        el('button', { class: 'btn btn-primary btn-small', text: editing >= 0 ? 'Update in tag list' : 'Add to tag list', attrs: { type: 'button' }, on: { mousedown: (e: Event) => e.preventDefault(), click: addEntry } }),
        el('button', { class: 'btn btn-small', text: editing >= 0 ? 'Cancel' : 'Clear', attrs: { type: 'button' }, on: { click: () => ((draft = blank(draft.type)), (editing = -1), (message = ''), render()) } }),
        message ? el('span', { class: message.startsWith('Added') ? 'tag-msg-ok' : 'tag-msg-bad', text: message }) : null,
      ),
    );
  }

  function renderList(): void {
    const rows = entries.map((e, i) =>
      el(
        'tr',
        { class: i === editing ? 'is-editing' : '' },
        el('td', { text: typeLabel(e.type) }),
        el('td', {}, el('div', { class: 'tag-chips' }, ...e.items.map((x) => el('span', { class: 'tag-chip tag-chip-static tag-chip-item', text: x })))),
        el('td', {}, el('div', { class: 'tag-chips' }, ...e.tags.map((t) => el('span', { class: 'tag-chip tag-chip-static', text: `${t.category}: ${t.tag}` })))),
        el(
          'td',
          { class: 'tag-row-actions' },
          el('button', {
            class: 'btn btn-small',
            text: 'Edit',
            attrs: { type: 'button' },
            on: {
              click: () => {
                draft = { type: e.type, items: [...e.items], tags: [...e.tags], category: '' };
                editing = i;
                message = '';
                render();
                editor.scrollIntoView({ block: 'nearest' });
              },
            },
          }),
          el('button', {
            class: 'tag-cat-x',
            text: '×',
            attrs: { type: 'button', title: 'Remove this entry', 'aria-label': `Remove entry ${i + 1}` },
            on: {
              click: () => {
                entries = entries.filter((_, j) => j !== i);
                if (editing === i) ((editing = -1), (draft = blank(draft.type)));
                else if (editing > i) editing--;
                message = '';
                commit();
                render();
              },
            },
          }),
        ),
      ),
    );

    const cats = categoriesFromEntries(entries);
    const itemCount = entries.reduce((n, e) => n + e.items.length, 0);
    replace(
      list,
      el('div', { class: 'tag-list-head' }, el('strong', { text: `Tag list (${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}, ${itemCount} item${itemCount === 1 ? '' : 's'})` })),
      entries.length === 0
        ? el('p', { class: 'muted', text: 'Empty. Add the first entry above.' })
        : el(
            'div',
            { class: 'table-wrap' },
            el('table', { class: 'data-table tag-table' }, el('thead', {}, el('tr', {}, ...['Type', 'Items', 'Tags', ''].map((h) => el('th', { text: h })))), el('tbody', {}, ...rows)),
          ),
      cats.length > 0
        ? el(
            'div',
            { class: 'tag-creates' },
            el('span', { class: 'muted', text: 'Generate creates: ' }),
            ...cats.map((c) => el('span', { class: 'tag-creates-cat' }, el('strong', { text: c.name }), el('span', { text: ` (${c.cardinality === 'multiple' ? 'several' : 'one'} per object, on ${c.types.map(typeLabel).join(', ')}): ${c.values.join(', ')}` }))),
          )
        : null,
    );
  }

  function render(): void {
    renderEditor();
    renderList();
  }

  render();
  return root;
}
