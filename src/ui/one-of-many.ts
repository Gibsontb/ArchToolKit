/**
 * One of many, with a way to get to any other.
 *
 * Three hundred dashboards, two hundred and fifty views, a hundred and
 * twenty-seven reports: all the same problem, and the answer that worked for
 * the first is the answer for the other two. A dropdown, Previous and Next, and
 * the thing itself — no second list, no wall of thumbnails, no third route to
 * the same place.
 *
 * The heading is built from the item rather than passed in, because what is
 * worth saying about a dashboard ("not shared, eleven widgets") is not what is
 * worth saying about a report ("never scheduled, PDF and CSV").
 */

import { el, append, replace } from './dom.ts';

export interface OneOfMany {
  readonly element: HTMLElement;
  /** Open a particular item by id, scrolling it into view. */
  show(id: string): void;
}

export interface OneOfManyOptions<T> {
  readonly items: readonly T[];
  /** "dashboard", "view", "report" — the label on the picker. */
  readonly noun: string;
  readonly idOf: (item: T) => string;
  /** The line in the dropdown. */
  readonly label: (item: T) => string;
  /** The heading over the item: a name and whatever matters about it. */
  readonly heading: (item: T) => readonly HTMLElement[];
  /** The item itself. */
  readonly render: (item: T) => HTMLElement;
  /** An optgroup heading, when the set divides usefully. */
  readonly group?: (item: T) => string;
  /** Sorted before anything else is done, so the order is the reading order. */
  readonly sort?: (a: T, b: T) => number;
  /** Buttons that belong beside Previous and Next. */
  readonly actions?: readonly HTMLElement[];
  readonly empty?: string;
}

export function oneOfMany<T>(options: OneOfManyOptions<T>): OneOfMany {
  const ordered = [...options.items].sort(options.sort ?? ((a, b) => options.label(a).localeCompare(options.label(b))));

  const picker = el('select', { attrs: { 'aria-label': options.noun } }) as HTMLSelectElement;
  const groups = new Map<string, HTMLElement>();
  ordered.forEach((item, index) => {
    const option = el('option', { text: options.label(item), attrs: { value: String(index) } });
    const groupName = options.group?.(item);
    if (!groupName) {
      append(picker, option);
      return;
    }
    let group = groups.get(groupName);
    if (!group) {
      group = el('optgroup', { attrs: { label: groupName } });
      groups.set(groupName, group);
      append(picker, group);
    }
    append(group, option);
  });

  const heading = el('div', { class: 'dash-heading' });
  const body = el('div', {});
  const position = el('span', { class: 'muted' });
  let at = 0;

  function show(index: number): void {
    if (ordered.length === 0) return;
    at = Math.min(Math.max(index, 0), ordered.length - 1);
    const item = ordered[at];
    if (!item) return;
    picker.value = String(at);
    position.textContent = `${at + 1} of ${ordered.length}`;
    replace(heading, ...options.heading(item));
    replace(body, options.render(item));
  }

  picker.addEventListener('change', () => show(Number(picker.value)));

  const controls = el(
    'div',
    { class: 'field-row dash-controls' },
    el(
      'div',
      { class: 'field' },
      el('div', { class: 'field-head' }, el('label', { text: options.noun })),
      picker,
    ),
    el(
      'div',
      { class: 'btn-row' },
      el('button', { class: 'btn btn-small', text: '← Previous', attrs: { type: 'button' }, on: { click: () => show(at - 1) } }),
      el('button', { class: 'btn btn-small', text: 'Next →', attrs: { type: 'button' }, on: { click: () => show(at + 1) } }),
      position,
      ...(options.actions ?? []),
    ),
  );

  const wrap = el('div', { class: 'stack' }, controls, heading, body);

  if (ordered.length === 0) {
    replace(body, el('p', { class: 'empty', text: options.empty ?? `No ${options.noun.toLowerCase()}s in this export.` }));
  } else {
    show(0);
  }

  return {
    element: wrap,
    show(id: string): void {
      const index = ordered.findIndex((item) => options.idOf(item) === id);
      if (index < 0) return;
      show(index);
      wrap.scrollIntoView({ block: 'start', behavior: 'smooth' });
    },
  };
}
