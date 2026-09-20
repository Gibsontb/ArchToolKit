/**
 * The Terraform Map.
 *
 * The question this answers comes before the generator's. The generator builds
 * a VPC; this says which resource builds a VPC on the cloud you are on, what
 * the neighbouring ones are, and what the previous toolkit decided about them.
 *
 * The previous toolkit kept one of these per cloud as a standalone page and
 * made you navigate between them. Here the cloud is the shared target, chosen
 * once and remembered for the tab, so arriving from the decision matrix or from
 * either generator lands on the right map without asking again.
 *
 * The findings panel is the part that could not exist as prose: every resource
 * name on the page is checked against the committed provider catalog, so a name
 * that has been renamed since the map was written says so here rather than at
 * plan time.
 */

import { el, append, replace, clear } from './dom.ts';
import { card, findingsList } from './components.ts';
import { getTarget, setTarget, type TargetId } from '../kit/target.ts';
import { MAPS, mapFor } from '../terraform/maps.ts';
import {
  mapCoverage,
  mapFindings,
  nameStatus,
  type CloudMap,
  type MapSection,
} from '../terraform/map.ts';
import type { CloudTarget } from '../terraform/providers.ts';

/**
 * A resource name, marked if the catalog has not heard of it.
 *
 * The mark is on the name rather than only in the findings panel because this
 * is a page people read a row at a time: a warning at the top saying four names
 * are stale does not tell you which row you are looking at is the bad one.
 */
function resourceName(target: CloudTarget, name: string): HTMLElement {
  const status = nameStatus(target, name);
  if (status === 'data-source') {
    return el('code', {
      class: 'map-name is-data',
      text: name,
      attrs: { title: 'A data source, not a resource.' },
    });
  }
  if (status === 'stale') {
    return el('code', {
      class: 'map-name is-unknown',
      text: name,
      attrs: {
        title:
          'Not in the committed provider catalog — renamed or removed since this map was written. See Findings.',
      },
    });
  }
  return el('code', { text: name });
}

/** Cells are prose except the resource column, which is marked up per name. */
function cellContent(target: CloudTarget, text: string, resources: readonly string[]): HTMLElement {
  const named = resources.filter((r) => text.includes(r));
  if (named.length === 0) return el('span', { text });

  const wrap = el('span', {});
  let rest = text;
  for (const name of named) {
    const at = rest.indexOf(name);
    if (at === -1) continue;
    if (at > 0) append(wrap, el('span', { text: rest.slice(0, at) }));
    append(wrap, resourceName(target, name));
    rest = rest.slice(at + name.length);
  }
  if (rest) append(wrap, el('span', { text: rest }));
  return wrap;
}

function sectionCard(map: CloudMap, section: MapSection, index: number): HTMLElement {
  const heading = el(
    'div',
    { class: 'card-title' },
    el('h2', { text: `${index}. ${section.title}` }),
  );
  if (section.badge) {
    append(heading, el('span', { class: 'pill', text: section.badge }));
  }

  const body = el('div', { class: 'map-section-body' });

  if (section.tagline) {
    append(body, el('p', { class: 'muted', text: section.tagline }));
  }

  for (const table of section.tables ?? []) {
    const head = el('tr');
    for (const header of table.headers) append(head, el('th', { text: header }));

    const tbody = el('tbody');
    for (const row of table.rows) {
      const tr = el('tr');
      for (const cell of row.cells) {
        append(tr, el('td', {}, cellContent(map.target, cell, row.resources)));
      }
      append(tbody, tr);
    }

    append(
      body,
      el(
        'div',
        { class: 'table-wrap' },
        el('table', { class: 'data-table map-table' }, el('thead', {}, head), tbody),
      ),
    );
  }

  for (const note of section.notes ?? []) {
    append(body, el('p', { class: 'map-note', text: note }));
  }

  for (const block of section.code ?? []) {
    append(body, el('pre', { class: 'code-block', text: block }));
  }

  for (const example of section.examples ?? []) {
    const summary = el('summary', {}, el('span', { text: example.title }));
    if (example.note) append(summary, el('span', { class: 'muted', text: ` — ${example.note}` }));
    append(
      body,
      el(
        'details',
        { class: 'map-example' },
        summary,
        el('pre', { class: 'code-block', text: example.code }),
      ),
    );
  }

  return el('section', { class: 'card map-section', attrs: { id: section.id } }, heading, body);
}

export function mountTerraformMapPage(root: HTMLElement): void {
  let target: TargetId = (getTarget()?.target ?? MAPS[0]?.target ?? 'aws') as TargetId;
  if (!mapFor(target)) target = MAPS[0]?.target ?? 'aws';

  const picker = el('select') as HTMLSelectElement;
  for (const map of MAPS) {
    const option = el('option', { text: map.label, attrs: { value: map.target } });
    if (map.target === target) (option as HTMLOptionElement).selected = true;
    append(picker, option);
  }

  const chooser = card(
    'Platform',
    el(
      'div',
      { class: 'field' },
      el(
        'div',
        { class: 'field-head' },
        el('label', { text: 'Platform' }),
        el('span', { class: 'field-hint', text: 'Chosen once, used everywhere' }),
      ),
      picker,
    ),
    el('div', { class: 'map-origin muted' }),
  );

  const contents = el('nav', { class: 'map-contents' });
  const sections = el('div', { class: 'map-sections' });
  const findings = el('div', {});

  function draw(): void {
    const map = mapFor(target);
    if (!map) {
      replace(sections, el('p', { class: 'muted', text: 'No map for this platform yet.' }));
      clear(contents);
      replace(findings, el('div', { class: 'empty', text: 'Nothing to check.' }));
      return;
    }

    const origin = chooser.querySelector('.map-origin');
    if (origin) {
      const { checked, known } = mapCoverage(map);
      origin.textContent =
        `${map.blurb} ${known} of ${checked} resource names verified against the committed catalog.`.trim();
    }

    clear(contents);
    append(contents, el('div', { class: 'map-contents-label', text: 'Domains' }));
    const list = el('ol');
    for (const section of map.sections) {
      append(
        list,
        el('li', {}, el('a', { text: section.title, attrs: { href: `#${section.id}` } })),
      );
    }
    append(contents, list);

    clear(sections);
    map.sections.forEach((section, i) => append(sections, sectionCard(map, section, i + 1)));

    replace(findings, findingsList(mapFindings(map), 'Nothing to report.'));
  }

  picker.addEventListener('change', () => {
    target = picker.value as TargetId;
    setTarget(target);
    draw();
  });

  replace(
    root,
    el(
      'div',
      { class: 'map-layout' },
      el('div', { class: 'map-aside' }, chooser, contents, card('Findings', findings)),
      sections,
    ),
  );
  draw();
}

const root = document.getElementById('terraform-map-root');
if (root) mountTerraformMapPage(root);
