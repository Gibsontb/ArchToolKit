/**
 * The Reference panel: the Terraform Map, for what was just generated.
 *
 * Collapsed by default, because it is reference rather than output — the point
 * is that it is *there*, not that it is in the way. Expanded, it shows the map
 * rows that name the resource types in the generated files, the worked examples
 * from those sections, and anything generated that the map has no row for.
 *
 * Every resource name is marked the same way it is on the map page, through the
 * same `nameStatus`, so a resource that has been renamed in a provider release
 * reads the same in both places.
 */

import { el, append } from './dom.ts';
import { card } from './components.ts';
import { referenceFor } from '../terraform/reference.ts';
import { nameStatus } from '../terraform/map.ts';
import type { CloudTarget } from '../terraform/providers.ts';

/** A resource name, marked if the committed catalog has not heard of it. */
function resourceName(target: CloudTarget, name: string): HTMLElement {
  const status = nameStatus(target, name);
  if (status === 'data-source') {
    return el('code', { class: 'map-name is-data', text: name, attrs: { title: 'A data source, not a resource.' } });
  }
  if (status === 'stale') {
    return el('code', {
      class: 'map-name is-unknown',
      text: name,
      attrs: { title: 'Not in the committed provider catalog — renamed or removed since this map was written.' },
    });
  }
  return el('code', { text: name });
}

/**
 * The panel, or nothing.
 *
 * Nothing when the platform has no map — vSphere and VCF do not — because an
 * empty panel reads as "the map knows nothing about this", when the truth is
 * that there is no map to consult.
 */
export function referencePanel(platform: string, files: Readonly<Record<string, string>>): readonly HTMLElement[] {
  const reference = referenceFor(platform, files);
  if (!reference) return [];
  if (reference.rows.length === 0 && reference.unmapped.length === 0) return [];

  const target = reference.target;
  const body = el('div', { class: 'map-section-body' });

  const summary =
    reference.rows.length > 0
      ? `${reference.rows.length} row${reference.rows.length === 1 ? '' : 's'} of the map cover ${reference.resources.length - reference.unmapped.length} of the ${reference.resources.length} resource type${reference.resources.length === 1 ? '' : 's'} this builds.`
      : `The map has nothing about the ${reference.resources.length} resource type${reference.resources.length === 1 ? '' : 's'} this builds.`;
  append(body, el('p', { class: 'muted', text: summary }));

  // Group by section, so the panel reads the way the map does.
  const bySection = new Map<string, typeof reference.rows>();
  for (const row of reference.rows) {
    const existing = bySection.get(row.section) ?? [];
    bySection.set(row.section, [...existing, row]);
  }

  for (const [section, rows] of bySection) {
    const heading = el('div', { class: 'card-title' }, el('h3', { text: section }));
    const first = rows[0];
    if (first) {
      append(
        heading,
        el('a', {
          class: 'btn btn-small',
          text: 'Open on the map →',
          attrs: { href: `terraform-map.html#${first.sectionId}`, title: 'The whole section, with everything around it' },
        }),
      );
    }
    append(body, heading);

    const table = el('table', {});
    const headers = first?.headers ?? [];
    const head = el('tr', {});
    for (const header of headers) append(head, el('th', { text: header }));
    append(table, head);

    for (const row of rows) {
      const line = el('tr', {});
      row.cells.forEach((text, index) => {
        const cell = el('td', {});
        // Mark up the resource names inside the cell, leaving the prose alone.
        const named = row.matched.filter((name) => text.includes(name));
        if (named.length === 0) {
          append(cell, el('span', { text }));
        } else {
          let rest = text;
          for (const name of named) {
            const at = rest.indexOf(name);
            if (at === -1) continue;
            if (at > 0) append(cell, el('span', { text: rest.slice(0, at) }));
            append(cell, resourceName(target, name));
            rest = rest.slice(at + name.length);
          }
          if (rest) append(cell, el('span', { text: rest }));
        }
        if (index < headers.length) append(line, cell);
      });
      append(table, line);
    }
    append(body, table);
  }

  if (reference.examples.length > 0) {
    append(body, el('div', { class: 'card-title' }, el('h3', { text: 'Worked examples from those sections' })));
    for (const example of reference.examples.slice(0, 4)) {
      const details = el('details', {});
      append(details, el('summary', { text: `${example.title} — ${example.section}` }));
      if (example.note) append(details, el('p', { class: 'muted', text: example.note }));
      append(details, el('pre', { class: 'mono code-block' }, example.code));
      append(body, details);
    }
  }

  if (reference.unmapped.length > 0) {
    const gap = el('div', { class: 'tip' });
    append(gap, el('strong', { text: 'Not on the map: ' }));
    reference.unmapped.forEach((name, index) => {
      if (index > 0) append(gap, el('span', { text: ', ' }));
      append(gap, resourceName(target, name));
    });
    append(
      gap,
      el('p', {
        class: 'muted',
        text: 'That is a gap in the map rather than a problem with what was generated. The map is the thing to extend.',
      }),
    );
    append(body, gap);
  }

  // Collapsed by default: reference, not output.
  const details = el('details', { class: 'reference-panel' });
  append(details, el('summary', { text: `Reference — ${summary}` }));
  append(details, body);

  return [card('Reference', details)];
}
