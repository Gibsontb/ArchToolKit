/**
 * The tag standard, built by picking.
 *
 * Add a category from the common list (or name your own), then choose single
 * or multiple, tick the object types it goes on, pick the types it is required
 * on, and add its values one at a time. Every change rewrites the standard in
 * the line format the tag blueprints read, and the page remembers it so the
 * other tag blueprints offer these categories and tags as choices.
 */

import { el, replace } from './dom.ts';
import {
  TAG_OBJECT_TYPES,
  TAG_PRESETS,
  parseTagStandard,
  rememberTagStandard,
  serializeTagStandard,
  type TagCategory,
} from '../kit/tag-standard.ts';

const typeLabel = (value: string): string => TAG_OBJECT_TYPES.find((t) => t.value === value)?.label ?? value;

/**
 * A builder whose value is the serialized standard. The element carries a
 * hidden textarea (class `tag-standard-value`) that always holds the current
 * text, so the page reads it like any other field.
 */
export function tagStandardBuilder(value: string, onChange: () => void): HTMLElement {
  let categories: TagCategory[] = parseTagStandard(value);
  const store = el('textarea', { class: 'tag-standard-value', attrs: { hidden: true } }) as HTMLTextAreaElement;
  const list = el('div', { class: 'tag-builder-list' });
  const adder = el('div', { class: 'tag-builder-add' });
  const root = el('div', { class: 'tag-builder' }, list, adder, store);

  const commit = (): void => {
    store.value = serializeTagStandard(categories);
    rememberTagStandard(store.value);
    onChange();
  };
  const update = (index: number, next: Partial<TagCategory>): void => {
    categories = categories.map((c, i) => (i === index ? { ...c, ...next } : c));
    commit();
  };

  function renderAdder(): void {
    const taken = new Set(categories.map((c) => c.name.toLowerCase()));
    const pick = el('select') as HTMLSelectElement;
    pick.appendChild(el('option', { text: 'Add a category…', attrs: { value: '' } }));
    for (const preset of TAG_PRESETS) {
      if (taken.has(preset.name.toLowerCase())) continue;
      pick.appendChild(el('option', { text: `${preset.name} — ${preset.description}`, attrs: { value: preset.name } }));
    }
    pick.appendChild(el('option', { text: 'Your own category…', attrs: { value: '__own__' } }));
    pick.addEventListener('change', () => {
      if (pick.value === '') return;
      const preset = TAG_PRESETS.find((p) => p.name === pick.value);
      categories = [
        ...categories,
        preset ?? { name: '', cardinality: 'single', types: ['VirtualMachine'], values: [], freeText: false, requiredOn: [], description: '' },
      ];
      commit();
      render();
      if (!preset) (list.lastElementChild?.querySelector('.tag-cat-name') as HTMLInputElement | null)?.focus();
    });
    replace(adder, pick);
  }

  function categoryCard(c: TagCategory, index: number): HTMLElement {
    const name = el('input', { class: 'tag-cat-name', attrs: { type: 'text', placeholder: 'Category name, e.g. Environment' } }) as HTMLInputElement;
    name.value = c.name;
    name.addEventListener('input', () => update(index, { name: name.value.trim() }));

    const card = el('select') as HTMLSelectElement;
    for (const [v, label] of [
      ['single', 'One tag per object'],
      ['multiple', 'Several tags per object'],
    ] as const) {
      const opt = el('option', { text: label, attrs: { value: v } }) as HTMLOptionElement;
      if (c.cardinality === v) opt.selected = true;
      card.appendChild(opt);
    }
    card.addEventListener('change', () => update(index, { cardinality: card.value === 'multiple' ? 'multiple' : 'single' }));

    // Object types: ticking one adds it; the required-on list follows.
    const types = el('div', { class: 'tag-chips' });
    for (const t of TAG_OBJECT_TYPES) {
      const box = el('input', { attrs: { type: 'checkbox' } }) as HTMLInputElement;
      box.checked = c.types.includes(t.value);
      box.addEventListener('change', () => {
        const next = box.checked ? [...categories[index]!.types, t.value] : categories[index]!.types.filter((x) => x !== t.value);
        update(index, { types: next, requiredOn: categories[index]!.requiredOn.filter((r) => next.includes(r)) });
        render();
      });
      types.appendChild(el('label', { class: 'tag-check' }, box, el('span', { text: t.label })));
    }

    const required = el('div', { class: 'tag-chips' });
    const requiredChoices = c.types.length > 0 ? c.types : TAG_OBJECT_TYPES.map((t) => t.value);
    for (const t of requiredChoices) {
      const box = el('input', { attrs: { type: 'checkbox' } }) as HTMLInputElement;
      box.checked = c.requiredOn.includes(t);
      box.addEventListener('change', () => {
        const cur = categories[index]!.requiredOn;
        update(index, { requiredOn: box.checked ? [...cur, t] : cur.filter((x) => x !== t) });
      });
      required.appendChild(el('label', { class: 'tag-check' }, box, el('span', { text: typeLabel(t) })));
    }

    // Values as chips, added one at a time.
    const chips = el('div', { class: 'tag-chips' });
    for (const v of c.values) {
      chips.appendChild(
        el(
          'span',
          { class: 'tag-chip' },
          el('span', { text: v }),
          el('button', {
            class: 'tag-chip-x',
            text: '×',
            attrs: { type: 'button', title: `Remove ${v}`, 'aria-label': `Remove ${v}` },
            on: {
              click: () => {
                update(index, { values: categories[index]!.values.filter((x) => x !== v) });
                render();
              },
            },
          }),
        ),
      );
    }
    const addValue = el('input', { attrs: { type: 'text', placeholder: c.freeText ? 'Free text: any value' : 'Add a tag, then Enter' } }) as HTMLInputElement;
    addValue.disabled = c.freeText;
    const add = (): void => {
      const parts = addValue.value.split(',').map((p) => p.trim()).filter(Boolean);
      const cur = categories[index]!.values;
      const fresh = parts.filter((p) => !cur.some((x) => x.toLowerCase() === p.toLowerCase()));
      if (fresh.length === 0) return;
      update(index, { values: [...cur, ...fresh] });
      render();
      (list.children[index]?.querySelector('.tag-value-input') as HTMLInputElement | null)?.focus();
    };
    addValue.classList.add('tag-value-input');
    addValue.addEventListener('keydown', (event) => {
      if ((event as KeyboardEvent).key === 'Enter') {
        event.preventDefault();
        add();
      }
    });
    const freeBox = el('input', { attrs: { type: 'checkbox' } }) as HTMLInputElement;
    freeBox.checked = c.freeText;
    freeBox.addEventListener('change', () => {
      update(index, { freeText: freeBox.checked });
      render();
    });

    const description = el('input', { attrs: { type: 'text', placeholder: 'What it is for' } }) as HTMLInputElement;
    description.value = c.description;
    description.addEventListener('input', () => update(index, { description: description.value }));

    const row = (label: string, ...nodes: HTMLElement[]): HTMLElement => el('div', { class: 'tag-row' }, el('div', { class: 'tag-row-label', text: label }), el('div', { class: 'tag-row-body' }, ...nodes));

    return el(
      'div',
      { class: 'tag-cat' },
      el(
        'div',
        { class: 'tag-cat-head' },
        name,
        el('button', {
          class: 'btn btn-small',
          text: 'Remove',
          attrs: { type: 'button' },
          on: {
            click: () => {
              categories = categories.filter((_, i) => i !== index);
              commit();
              render();
            },
          },
        }),
      ),
      row('Tags per object', card),
      row('Goes on', types),
      row('Required on', required),
      row('Tags', chips, el('div', { class: 'tag-add-row' }, addValue, el('button', { class: 'btn btn-small', text: 'Add', attrs: { type: 'button' }, on: { click: add } }), el('label', { class: 'tag-check' }, freeBox, el('span', { text: 'Free text' })))),
      row('Description', description),
    );
  }

  function render(): void {
    replace(list, ...categories.map(categoryCard));
    if (categories.length === 0) list.appendChild(el('p', { class: 'muted', text: 'No categories yet. Add one below.' }));
    renderAdder();
  }

  store.value = serializeTagStandard(categories);
  render();
  return root;
}
