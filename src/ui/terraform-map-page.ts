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
import {
  DOMAIN_LABELS,
  EQUIVALENCE_DOMAINS,
  EQUIVALENCE_PLATFORMS,
  EQUIVALENCE_ROWS,
  MODULE_EQUIVALENCE,
  UNMAPPED,
  equivalenceCoverage,
  platformOfType,
  type EquivalenceDomain,
  type EquivalenceRow,
  type PlatformCell,
} from '../terraform/equivalence.ts';
import { PLATFORM_LABELS } from '../multicloud/plan/options.ts';
import type { Platform } from '../multicloud/platforms.ts';

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

// ------------------------------------------------------------ across clouds ---

/**
 * The equivalence map beside the per-cloud maps: one row per job, one column
 * per platform, so the map's "which resource does this" gains the question the
 * migration planner asks — "and what is it over there?".
 *
 * A gap is shown as a gap, with its reason, never as an empty cell: the
 * reasons are the part worth reading when a platform switch is on the table.
 */
function typeCode(name: string): HTMLElement {
  const platform = platformOfType(name);
  if (!platform) return el('code', { text: name });
  const target: CloudTarget = platform === 'vmware' ? 'vsphere' : platform;
  return resourceName(target, name);
}

function joined(parent: HTMLElement, types: readonly string[], sep: string, extra?: (i: number) => string): void {
  types.forEach((t, i) => {
    if (i > 0) append(parent, el('span', { text: sep }));
    append(parent, typeCode(t));
    const tail = extra?.(i);
    if (tail) append(parent, el('span', { text: tail }));
  });
}

function equivalenceCell(cell: PlatformCell | undefined): HTMLElement {
  if (!cell) return el('span', { class: 'faint', text: '—' });
  if (cell.none !== undefined) {
    return el('div', {}, el('span', { class: 'badge danger', text: 'No equivalent' }), el('div', { class: 'small muted', text: cell.none }));
  }
  const wrap = el('div', {});
  joined(wrap, cell.primary, ' + ');
  const alternatives = cell.alternatives ?? [];
  if (alternatives.length > 0) {
    const alt = el('div', { class: 'small muted' }, el('span', { text: 'or ' }));
    joined(alt, alternatives.map((a) => a.type), ', ', (i) => (alternatives[i]?.os ? ` (${alternatives[i]?.os})` : ''));
    append(wrap, alt);
  }
  if (cell.supporting?.length) {
    const sup = el('div', { class: 'small muted' }, el('span', { text: 'with ' }));
    joined(sup, cell.supporting, ', ');
    append(wrap, sup);
  }
  if (cell.note) append(wrap, el('div', { class: 'small faint', text: cell.note }));
  return wrap;
}

function attributesDetail(row: EquivalenceRow): HTMLElement | null {
  if (row.attributes.length === 0) return null;
  const head = el('tr', {}, el('th', { text: 'Carries' }), ...EQUIVALENCE_PLATFORMS.map((p) => el('th', { text: PLATFORM_LABELS[p] })));
  const body = el('tbody');
  for (const map of row.attributes) {
    const tr = el('tr', {}, el('td', { text: map.concept }));
    for (const p of EQUIVALENCE_PLATFORMS) {
      const t = map.per[p];
      if (!t) {
        append(tr, el('td', { class: 'faint', text: '—' }));
        continue;
      }
      const companions = [...new Set(Object.values(t.companions ?? {}))].filter((c) => c !== t.path);
      const cellEl = el('td', {}, el('code', { text: `${t.type}.${t.path}` }));
      if (companions.length > 0) append(cellEl, el('span', { class: 'small muted', text: ` + ${companions.join(', ')}` }));
      if (t.transform && t.transform !== 'same') append(cellEl, el('span', { class: 'small muted', text: ` (${t.transform})` }));
      append(tr, cellEl);
    }
    append(body, tr);
  }
  return el(
    'details',
    { class: 'map-example' },
    el('summary', {}, el('span', { text: `Attributes carried on a switch (${row.attributes.length})` })),
    el('div', { class: 'table-wrap' }, el('table', { class: 'data-table map-table' }, el('thead', {}, head), body)),
  );
}

function selectOf(options: readonly (readonly [string, string])[]): HTMLSelectElement {
  const select = el('select') as HTMLSelectElement;
  for (const [value, label] of options) append(select, el('option', { text: label, attrs: { value } }));
  return select;
}

function labelled(label: string, control: HTMLElement, grow = false): HTMLElement {
  return el(
    'div',
    { class: 'field', ...(grow ? { style: { flex: '1 1 16rem' } } : {}) },
    el('div', { class: 'field-head' }, el('label', { text: label })),
    control,
  );
}

function mountAcrossClouds(root: HTMLElement, openMap: (platform: Platform, section: string) => void, initialRow?: string): void {
  const coverage = equivalenceCoverage();
  const domains = EQUIVALENCE_DOMAINS.filter((d) => coverage.byDomain[d] > 0);

  const domain = selectOf([['', 'All domains'], ...domains.map((d) => [d, `${DOMAIN_LABELS[d]} (${coverage.byDomain[d]})`] as const)]);
  const gapsOn = selectOf([
    ['', 'Every row'],
    ...EQUIVALENCE_PLATFORMS.map((p) => [p, `Gaps on ${PLATFORM_LABELS[p]} (${coverage.gaps[p].length})`] as const),
  ]);
  const search = el('input', { attrs: { type: 'search', placeholder: 'A job or a resource type', 'aria-label': 'Search' } }) as HTMLInputElement;

  const filters = el(
    'div',
    { class: 'filter-row', style: { display: 'flex', flexWrap: 'wrap', gap: 'var(--space-3)', alignItems: 'flex-end' } },
    labelled('Domain', domain),
    labelled('Show', gapsOn),
    labelled('Search', search, true),
  );

  const summary = el('p', {
    class: 'muted',
    text:
      `${coverage.rows} equivalence families in ${domains.length} domains, naming ${coverage.types} resource types, each checked against the committed provider catalog. ` +
      'Switching an application to another platform translates its components through these rows: arguments carry where a row maps them, ' +
      'and a component with no equivalent is kept and flagged, never dropped. Product names are indicative; the resource types are what is checked.',
  });

  const count = el('p', { class: 'small muted' });
  const tableBody = el('tbody');
  const head = el('tr', {}, el('th', { text: 'Job' }), ...EQUIVALENCE_PLATFORMS.map((p) => el('th', { text: PLATFORM_LABELS[p] })));

  function rowMatches(row: EquivalenceRow): boolean {
    if (domain.value && row.domain !== (domain.value as EquivalenceDomain)) return false;
    if (gapsOn.value && row.per[gapsOn.value as Platform]?.none === undefined) return false;
    const q = search.value.trim().toLowerCase();
    if (!q) return true;
    const words = [row.id, row.label];
    for (const c of Object.values(row.per)) {
      if (!c) continue;
      words.push(...c.primary, ...(c.supporting ?? []), ...(c.alternatives ?? []).map((a) => a.type), c.none ?? '');
    }
    return words.join(' ').toLowerCase().includes(q);
  }

  function jobCell(row: EquivalenceRow): HTMLElement {
    const job = el(
      'td',
      { attrs: { id: `eq-${row.id}` } },
      el('strong', { text: row.label }),
      el('div', { class: 'small faint', text: `${row.id} · ${DOMAIN_LABELS[row.domain]}` }),
    );
    const links = Object.entries(row.mapSection ?? {}) as [Platform, string][];
    if (links.length > 0) {
      const nav = el('div', { class: 'small' }, el('span', { class: 'muted', text: 'On the map: ' }));
      links.forEach(([p, section], i) => {
        if (i > 0) append(nav, el('span', { text: ' · ' }));
        append(
          nav,
          el('a', {
            text: PLATFORM_LABELS[p],
            attrs: { href: `#map:${section}` },
            on: {
              click: (event) => {
                event.preventDefault();
                openMap(p, section);
              },
            },
          }),
        );
      });
      append(job, nav);
    }
    const details = attributesDetail(row);
    if (details) append(job, details);
    return job;
  }

  function draw(): void {
    clear(tableBody);
    const rows = EQUIVALENCE_ROWS.filter(rowMatches);
    count.textContent = `${rows.length} of ${EQUIVALENCE_ROWS.length} rows shown.`;
    for (const row of rows) {
      append(tableBody, el('tr', {}, jobCell(row), ...EQUIVALENCE_PLATFORMS.map((p) => el('td', {}, equivalenceCell(row.per[p])))));
    }
    if (rows.length === 0) {
      append(tableBody, el('tr', {}, el('td', { class: 'empty', text: 'No row matches.', attrs: { colspan: String(EQUIVALENCE_PLATFORMS.length + 1) } })));
    }
  }

  domain.addEventListener('change', draw);
  gapsOn.addEventListener('change', draw);
  search.addEventListener('input', draw);

  const unmapped = el(
    'details',
    { class: 'map-example' },
    el(
      'summary',
      {},
      el('span', { text: `Not aligned, on purpose (${UNMAPPED.length})` }),
      el('span', { class: 'muted', text: ' — named by a map or a migration blueprint, kept out of the rows for the reason given' }),
    ),
    el(
      'div',
      { class: 'table-wrap' },
      el(
        'table',
        { class: 'data-table map-table' },
        el('thead', {}, el('tr', {}, el('th', { text: 'Type' }), el('th', { text: 'Why it is not aligned' }))),
        el('tbody', {}, ...UNMAPPED.map((u) => el('tr', {}, el('td', {}, typeCode(u.type)), el('td', { text: u.reason })))),
      ),
    ),
  );

  const moduleRows = MODULE_EQUIVALENCE.map((m) => {
    const tr = el('tr', {}, el('td', { text: m.label }));
    for (const p of EQUIVALENCE_PLATFORMS) {
      const c = m.per[p];
      if (!c) append(tr, el('td', { class: 'faint', text: '—' }));
      else if ('module' in c) append(tr, el('td', {}, el('code', { text: c.module })));
      else append(tr, el('td', {}, el('span', { class: 'badge danger', text: 'No equivalent' }), el('div', { class: 'small muted', text: c.none })));
    }
    return tr;
  });
  const modules = el(
    'details',
    { class: 'map-example' },
    el(
      'summary',
      {},
      el('span', { text: `Ansible modules (${MODULE_EQUIVALENCE.length})` }),
      el('span', { class: 'muted', text: ' — OS-level modules (ansible.builtin, ansible.windows, ansible.posix, community.general …) carry over unchanged' }),
    ),
    el(
      'div',
      { class: 'table-wrap' },
      el(
        'table',
        { class: 'data-table map-table' },
        el('thead', {}, el('tr', {}, el('th', { text: 'Job' }), ...EQUIVALENCE_PLATFORMS.map((p) => el('th', { text: PLATFORM_LABELS[p] })))),
        el('tbody', {}, ...moduleRows),
      ),
    ),
  );

  replace(
    root,
    card('Across clouds', summary, filters, count),
    el('section', { class: 'card map-section' }, el('div', { class: 'table-wrap' }, el('table', { class: 'data-table map-table' }, el('thead', {}, head), tableBody))),
    card('Also in the map', unmapped, modules),
  );
  draw();
  if (initialRow) setTimeout(() => globalThis.document?.getElementById(`eq-${initialRow}`)?.scrollIntoView({ block: 'start' }), 0);
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
    // The map says which resource does the job; the generator writes it.
    el(
      'div',
      { class: 'btn-row', style: { marginTop: 'var(--space-3)' } },
      el('a', { class: 'btn btn-small', text: 'Write some of this →', attrs: { href: 'terraform.html', title: 'Open the Terraform generator on this platform' } }),
    ),
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

  const byCloud = el(
    'div',
    { class: 'map-layout' },
    el('div', { class: 'map-aside' }, chooser, contents, card('Findings', findings)),
    sections,
  );
  const across = el('div', {});
  let acrossMounted = false;

  // Two views of one subject: the per-cloud maps, and the same jobs lined up
  // across the five platforms. `#map:across[:<row-id>]` opens the second.
  type View = 'cloud' | 'across';
  const strip = el('div', { class: 'tabs', attrs: { role: 'tablist' } });

  function show(view: View, row?: string): void {
    for (const tab of Array.from(strip.querySelectorAll<HTMLElement>('.tab'))) {
      const on = tab.dataset['view'] === view;
      tab.classList.toggle('active', on);
      tab.setAttribute('aria-selected', String(on));
    }
    byCloud.style.display = view === 'cloud' ? '' : 'none';
    across.style.display = view === 'across' ? 'block' : 'none';
    if (view === 'across' && !acrossMounted) {
      acrossMounted = true;
      mountAcrossClouds(across, openMap, row);
    }
  }

  function openMap(platform: Platform, section: string): void {
    if (platform !== 'vmware' && mapFor(platform)) {
      target = platform as TargetId;
      picker.value = target;
      setTarget(target);
      draw();
    }
    show('cloud');
    setTimeout(() => globalThis.document?.getElementById(section)?.scrollIntoView({ block: 'start' }), 0);
  }

  const views: readonly (readonly [View, string])[] = [
    ['cloud', 'By cloud'],
    ['across', 'Across clouds'],
  ];
  for (const [id, label] of views) {
    append(
      strip,
      el('div', {
        class: 'tab',
        text: label,
        dataset: { view: id },
        attrs: { role: 'tab', tabindex: '0' },
        on: {
          click: () => show(id),
          keydown: (event) => {
            const key = (event as KeyboardEvent).key;
            if (key === 'Enter' || key === ' ') {
              event.preventDefault();
              show(id);
            }
          },
        },
      }),
    );
  }

  replace(root, strip, byCloud, across);
  draw();

  // `#map:aws-networking` opens the map on one section — the reference panel
  // under generated output links here, and so does the old page's redirect.
  // `#map:across` and `#map:across:<row-id>` open the cross-cloud view.
  const [, section, row] = (globalThis.location?.hash ?? '').split(':');
  if (section === 'across') {
    show('across', row ? decodeURIComponent(row) : undefined);
  } else {
    show('cloud');
    if (section) setTimeout(() => globalThis.document?.getElementById(decodeURIComponent(section))?.scrollIntoView({ block: 'start' }), 0);
  }
}

// Mounted by terraform-page.ts as a tab. It was a page of its own until a
// reference you have to navigate to turned out to be a reference nobody opens.
