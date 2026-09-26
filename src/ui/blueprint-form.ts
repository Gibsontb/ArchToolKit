/**
 * A blueprint's inputs, rendered as a form.
 *
 * One implementation for every page that asks a blueprint's questions: the
 * generator pages (Terraform, Ansible, Network, Automation) and the migration
 * pages, which describe their own settings cards as blueprint inputs so they
 * get the same controls — dropdowns for closed sets, " | " grids for rows of
 * columns, chips for lists, follow-up questions that appear and go.
 *
 * The form holds no state of its own. It reads the values through
 * `values()` and writes each change through `set(id, value)`, so the page
 * keeps the values where it likes (a local object, the plan).
 */

import { el } from './dom.ts';
import { currentTagStandard, tagChoices } from '../kit/tag-standard.ts';
import { tagStandardBuilder } from './tag-standard-builder.ts';
import { autogrow, isListField, listEditor, tableEditor, tableShape } from './multi-editors.ts';
import { estateOptionsFor } from '../kit/estate.ts';
import { isVisible, type Blueprint, type BlueprintInput, type BlueprintValues, type SelectOption } from '../kit/blueprint.ts';

/** A blueprint's tag standard starts from the one last built on the page, so the tag blueprints build on each other. */
export function withCurrentTags(blueprint: Blueprint, values: BlueprintValues): BlueprintValues {
  const saved = currentTagStandard();
  const input = blueprint.inputs.find((i) => i.control === 'tag-standard');
  return saved && input ? { ...values, [input.id]: saved } : values;
}

/** What the page remembers for fields that offer it (index names defined on the Splunk page, …). */
const REMEMBER_PREFIX = 'archtoolkit.remember.';
function remembered(key: string): string[] {
  try {
    const raw = globalThis.localStorage?.getItem(REMEMBER_PREFIX + key);
    const list = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(list) ? list.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}
export function remember(key: string, value: string): void {
  const v = value.trim();
  if (!v) return;
  try {
    const list = remembered(key).filter((x) => x !== v);
    globalThis.localStorage?.setItem(REMEMBER_PREFIX + key, JSON.stringify([v, ...list].slice(0, 50)));
  } catch {
    // Not remembering only means the other fields do not offer it.
  }
}
/** A field that offers remembered values: they come first, under their own heading. */
export function withRemembered(input: BlueprintInput): BlueprintInput {
  if (!input.offer) return input;
  const mine = remembered(input.offer).filter((v) => !(input.options ?? []).some((o) => o.value === v && o.group === undefined));
  if (mine.length === 0) return input;
  return { ...input, control: input.control === 'text' ? 'combo' : input.control, options: [...mine.map((v) => ({ value: v, label: v, group: 'Defined on this page' })), ...(input.options ?? [])] };
}

/** An input that names categories or tags, offered from the tag standard rather than typed. */
export function withTags(input: BlueprintInput): BlueprintInput {
  if (!input.fromTags) return input;
  const { categories, tags } = tagChoices();
  if (input.fromTags === 'categories') return { ...input, control: 'checklist', options: categories.map((c) => ({ value: c, label: c })) };
  if (input.fromTags === 'category') return { ...input, control: 'combo', options: categories.map((c) => ({ value: c, label: c })) };
  return {
    ...input,
    control: 'combo',
    options: tags.map((t) => ({ value: `${t.category}=${t.tag}`, label: `${t.category} = ${t.tag}`, group: t.category })),
  };
}

/**
 * The input, with anything the imported estate can answer folded in.
 *
 * A blueprint cannot know your datastore names, but the inventory does. Where
 * it has an answer the field becomes a dropdown you can still type into, so an
 * estate that was imported after the blueprint was written is still offered.
 */
export function withEstate(input: BlueprintInput, target: string): BlueprintInput {
  const estate = estateOptionsFor(target, input.id);
  if (!estate) return input;
  const existing = (input.options ?? []).map((o) => o.value);
  const added = estate.values.filter((v) => !existing.includes(v));
  if (added.length === 0) return input;
  return {
    ...input,
    control: 'combo',
    hint: input.hint ? `${input.hint} · from ${estate.origin}` : `From ${estate.origin}`,
    options: [...added.map((value) => ({ value, label: value })), ...(input.options ?? [])],
  };
}

/**
 * Fills a `<select>`, opening an `<optgroup>` whenever the group changes.
 *
 * The long sets carry a group on every option and arrive already sorted into
 * them, so following the changes in order is enough — no regrouping, and an
 * ungrouped set costs nothing.
 */
export function fillOptions(
  select: HTMLSelectElement,
  options: readonly SelectOption[],
  selected: string,
): void {
  let group: HTMLOptGroupElement | null = null;
  let groupName: string | undefined;
  for (const option of options) {
    const opt = el('option', { text: option.label, attrs: { value: option.value } });
    if (option.value === selected) (opt as HTMLOptionElement).selected = true;
    if (option.group !== groupName) {
      groupName = option.group;
      group =
        groupName === undefined
          ? null
          : (el('optgroup', { attrs: { label: groupName } }) as HTMLOptGroupElement);
      if (group) select.appendChild(group);
    }
    (group ?? select).appendChild(opt);
  }
}

/**
 * The options, led by an empty one when the input says what empty means.
 *
 * On an optional module input, empty is "leave it to the module". Without an
 * empty option a dropdown cannot say that — and drawing it would quietly pick
 * its first entry and write it into the call.
 */
export function withBlank(input: BlueprintInput): readonly SelectOption[] {
  const options = input.options ?? [];
  if (input.blankLabel === undefined || options.some((o) => o.value === '')) return options;
  return [{ value: '', label: input.blankLabel }, ...options];
}

/** The value `control` built for its input: the value `set` is given. */
export function controlValue(node: HTMLElement): string {
  if (node.classList.contains('tag-builder')) return (node.querySelector('.tag-standard-value') as HTMLTextAreaElement).value;
  if (node.classList.contains('list-editor') || node.classList.contains('table-editor')) return (node.querySelector('.multi-value') as HTMLTextAreaElement).value;
  if (node.classList.contains('checklist')) return (node.querySelector('.checklist-value') as HTMLInputElement).value;
  if (node.classList.contains('combo')) {
    const picker = node.querySelector('select') as HTMLSelectElement;
    const typed = node.querySelector('input') as HTMLInputElement;
    return picker.value === '__custom__' ? typed.value : picker.value;
  }
  return (node as HTMLInputElement | HTMLSelectElement).value;
}

/** The control for one input. `onStructure` is called when the tag standard's categories change. */
export function control(input: BlueprintInput, value: unknown, onChange: () => void, onStructure: () => void = onChange): HTMLElement {
  if (input.control === 'tag-standard') return tagStandardBuilder(String(value ?? ''), onChange, onStructure);
  // Several things in one field: chips for a list, a grid for rows of columns.
  if (isListField(input)) return listEditor(input, String(value ?? ''), onChange);
  const shape = tableShape(input);
  if (shape) return tableEditor(shape, String(value ?? ''), onChange);

  if (input.control === 'checklist') {
    const picked = new Set(String(value ?? '').split(',').map((v) => v.trim()).filter(Boolean));
    const store = el('input', { class: 'checklist-value', attrs: { type: 'hidden' } }) as HTMLInputElement;
    store.value = [...picked].join(', ');
    const wrap = el('div', { class: 'checklist tag-chips' });
    // Anything already chosen that the list no longer offers stays ticked, so nothing is dropped silently.
    const options = [...(input.options ?? []), ...[...picked].filter((p) => !(input.options ?? []).some((o) => o.value === p)).map((p) => ({ value: p, label: p }))];
    for (const option of options) {
      const box = el('input', { attrs: { type: 'checkbox' } }) as HTMLInputElement;
      box.checked = picked.has(option.value);
      box.addEventListener('change', () => {
        if (box.checked) picked.add(option.value);
        else picked.delete(option.value);
        store.value = [...picked].join(', ');
        onChange();
      });
      wrap.appendChild(el('label', { class: 'tag-check' }, box, el('span', { text: option.label })));
    }
    if (options.length === 0) wrap.appendChild(el('span', { class: 'muted', text: 'Nothing to pick yet.' }));
    wrap.appendChild(store);
    return wrap;
  }

  if (input.control === 'select') {
    const node = el('select') as HTMLSelectElement;
    fillOptions(node, withBlank(input), String(value ?? ''));
    node.addEventListener('change', onChange);
    return node;
  }

  if (input.control === 'toggle') {
    // A yes/no is a two-option dropdown rather than a checkbox, so it reads the
    // same way as every other choice on the form and carries its own labels.
    const node = el('select') as HTMLSelectElement;
    for (const option of [
      { value: 'true', label: 'Yes' },
      { value: 'false', label: 'No' },
    ]) {
      const opt = el('option', { text: option.label, attrs: { value: option.value } });
      if (option.value === String(value)) (opt as HTMLOptionElement).selected = true;
      node.appendChild(opt);
    }
    node.addEventListener('change', onChange);
    return node;
  }

  if (input.control === 'combo') {
    /*
     * A real dropdown, with a way out.
     *
     * This was a datalist first, which was a mistake: a datalist shows no arrow
     * and no list until you type into it, so a field with thirteen machine
     * types in it looked exactly like an empty text box. A select shows what is
     * on offer without being asked.
     *
     * The last entry swaps in a text box, because these sets are the common
     * answers rather than the only ones — a machine type the list has not heard
     * of still has to be typeable.
     */
    const CUSTOM = '__custom__';
    const options = withBlank(input);
    const current = String(value ?? '');
    const known = options.some((o) => o.value === current);

    const select = el('select') as HTMLSelectElement;
    fillOptions(select, options, current);
    const customOption = el('option', {
      text: 'Other — type a value…',
      attrs: { value: CUSTOM },
    }) as HTMLOptionElement;
    if (!known && current !== '') customOption.selected = true;
    select.appendChild(customOption);

    const custom = el('input', {
      attrs: { type: 'text', placeholder: input.placeholder ?? 'Type a value' },
    }) as HTMLInputElement;
    custom.value = known ? '' : current;
    custom.style.display = known || current === '' ? 'none' : '';
    custom.style.marginTop = 'var(--space-2)';

    const wrap = el('div', { class: 'combo' }, select, custom);

    select.addEventListener('change', () => {
      const picked = select.value === CUSTOM;
      custom.style.display = picked ? '' : 'none';
      if (picked) custom.focus();
      onChange();
    });
    custom.addEventListener('input', onChange);
    return wrap;
  }

  if (input.control === 'textarea') {
    const node = el('textarea', {
      attrs: {
        rows: String(Math.min(8, Math.max(3, (input.placeholder ?? '').split('\n').length))),
        spellcheck: 'false',
        ...(input.placeholder ? { placeholder: input.placeholder } : {}),
      },
    }) as HTMLTextAreaElement;
    node.value = String(value ?? '');
    node.addEventListener('input', onChange);
    return autogrow(node);
  }

  const node = el('input', {
    attrs: {
      type: input.control === 'number' ? 'number' : 'text',
      ...(input.placeholder ? { placeholder: input.placeholder } : {}),
      ...(input.min !== undefined ? { min: String(input.min) } : {}),
      ...(input.max !== undefined ? { max: String(input.max) } : {}),
    },
  }) as HTMLInputElement;
  node.value = String(value ?? '');
  node.addEventListener('input', onChange);
  return node;
}

/** Label on the left, hint on the right, control underneath. */
export function labelledField(input: BlueprintInput, node: HTMLElement): HTMLElement {
  return el(
    'div',
    {
      class: 'field',
      attrs: { 'data-search': `${input.id} ${input.label} ${input.help ?? ''}`.toLowerCase() },
    },
    el(
      'div',
      { class: 'field-head' },
      el('label', { text: input.label }),
      input.hint ? el('span', { class: 'field-hint', text: input.hint, attrs: { title: input.hint } }) : null,
    ),
    node,
    input.help ? el('div', { class: 'field-help', text: input.help }) : null,
  );
}

/**
 * A collapsed section of optional inputs, with a filter.
 *
 * A module can take two hundred inputs. Laid out flat they would bury the
 * dozen that matter; hidden they would make the kit look like it only knew a
 * dozen. So they are here, closed until opened, and searchable by name or by
 * what the description says.
 */
export function inputSection(title: string, fields: readonly HTMLElement[], touched: number): HTMLElement {
  const filter = el('input', {
    attrs: { type: 'search', placeholder: `Filter ${fields.length} inputs by name or description` },
  }) as HTMLInputElement;
  const list = el('div', { class: 'input-section-list' }, ...fields);
  const count = el('span', { class: 'muted', text: '' });

  filter.addEventListener('input', () => {
    const q = filter.value.trim().toLowerCase();
    let shown = 0;
    for (const field of fields) {
      const hit = q === '' || (field.getAttribute('data-search') ?? '').includes(q);
      field.style.display = hit ? '' : 'none';
      if (hit) shown += 1;
    }
    count.textContent = q === '' ? '' : `${shown} match${shown === 1 ? '' : 'es'}`;
  });

  const summary = el(
    'summary',
    {},
    el('span', { text: title }),
    touched > 0 ? el('span', { class: 'pill', text: `${touched} set` }) : null,
  );
  return el(
    'details',
    { class: 'input-section' },
    summary,
    el('div', { class: 'input-section-filter' }, filter, count),
    list,
  );
}

// ---------------------------------------------------------------------------
// The form
// ---------------------------------------------------------------------------

export interface BlueprintFormOptions {
  /**
   * The platform the estate's answers are looked up for (datastore names and
   * the like). Omitted: the estate is not consulted.
   */
  readonly target?: string;
  /** The values as they stand. */
  values(): BlueprintValues;
  /** One input's new value. */
  set(inputId: string, value: string): void;
  /**
   * Draw the form again: a follow-up question appeared or went away, or the
   * tag standard's categories changed. Without it the form stays as drawn.
   */
  rerender?(): void;
  /** Inputs to leave out (a workspace edits them). */
  skip?(inputId: string): boolean;
  /**
   * A control beside a free-text field that fills it (the build list's
   * references). Not offered on dropdowns, tick lists, grids or chips.
   */
  reference?(set: (text: string) => void): HTMLElement | null;
}

/** The input as the page offers it: remembered values, tag choices and estate answers folded in. */
function offered(raw: BlueprintInput, target: string | undefined): BlueprintInput {
  return withRemembered(withTags(target === undefined ? raw : withEstate(raw, target)));
}

/**
 * One input as a labelled field bound to the values, or null when it is not
 * shown for the values as they stand. `after` runs after each change.
 */
export function blueprintField(raw: BlueprintInput, options: Pick<BlueprintFormOptions, 'target' | 'values' | 'set'>, after?: () => void): HTMLElement | null {
  if (!isVisible(raw, options.values())) return null;
  const input = offered(raw, options.target);
  const node = control(input, options.values()[input.id], () => {
    options.set(input.id, controlValue(node));
    after?.();
  });
  node.setAttribute('data-input', input.id);
  return labelledField(input, node);
}

/**
 * The form's fields, in the blueprint's order: the headline inputs first, then
 * each `section` as a collapsed, filterable group. Hidden follow-up questions
 * are left out; the caller puts the fields in its card.
 */
export function renderBlueprintForm(blueprint: Pick<Blueprint, 'inputs'>, options: BlueprintFormOptions): HTMLElement[] {
  const fields: HTMLElement[] = [];
  const sectioned = new Map<string, HTMLElement[]>();
  const touchedIn = new Map<string, number>();

  for (const raw of blueprint.inputs) {
    if (!isVisible(raw, options.values())) continue;
    if (options.skip?.(raw.id)) continue;
    const input = offered(raw, options.target);
    const node = control(input, options.values()[input.id], () => {
      options.set(input.id, controlValue(node));
      // A follow-up question may have appeared or gone away.
      if (blueprint.inputs.some((i) => i.showWhen?.input === input.id)) options.rerender?.();
    }, () => {
      // A category was added or removed: the fields that offer categories and tags follow.
      if (blueprint.inputs.some((i) => i.fromTags)) options.rerender?.();
    });
    node.setAttribute('data-input', input.id);
    const setValue = (text: string) => {
      const box = (node.classList.contains('combo') ? node.querySelector('input') : node) as HTMLInputElement | HTMLTextAreaElement | null;
      if (!box) return;
      if (node.classList.contains('combo')) {
        const picker = node.querySelector('select') as HTMLSelectElement;
        picker.value = '__custom__';
        (box as HTMLInputElement).style.display = '';
      }
      box.value = text;
      box.dispatchEvent(new Event('input'));
      box.focus();
    };
    const reference =
      !options.reference || input.control === 'select' || input.control === 'toggle' || input.control === 'checklist' || input.control === 'tag-standard' || node.classList.contains('list-editor') || node.classList.contains('table-editor')
        ? null
        : options.reference(setValue);
    const field = labelledField(input, reference ? el('div', { class: 'with-ref' }, node, reference) : node);
    if (input.section === undefined) {
      fields.push(field);
    } else {
      const list = sectioned.get(input.section) ?? [];
      list.push(field);
      sectioned.set(input.section, list);
      if (String(options.values()[input.id] ?? '') !== '') {
        touchedIn.set(input.section, (touchedIn.get(input.section) ?? 0) + 1);
      }
    }
  }

  for (const [title, list] of sectioned) {
    fields.push(inputSection(title, list, touchedIn.get(title) ?? 0));
  }
  return fields;
}
