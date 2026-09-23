/**
 * Tabs, for a page that is two things.
 *
 * The Terraform page is a generator and a reference map; the Scripts page is a
 * generator and a command catalogue. In both cases those are one subject and
 * were two navigation entries, which meant the reference was somewhere you had
 * to go rather than somewhere you were.
 *
 * Panes mount lazily and stay mounted. That matters: the map builds a few
 * hundred rows and the catalogue more than that, and doing it on page load
 * would slow down the generator, which is the tab most people want.
 *
 * The tab is written into the URL hash, so a link to `terraform.html#map`
 * opens on the map — which is what the old separate page's URL now redirects
 * to, and what anything that bookmarked it will follow.
 */

import { el, append, clear } from './dom.ts';

export interface Pane {
  readonly id: string;
  readonly label: string;
  /** Called once, the first time the pane is shown. */
  readonly mount: (container: HTMLElement) => void;
  /** Extra hashes that should also open this pane — an old page's anchors. */
  readonly alsoMatches?: readonly string[];
}

export function mountTabs(root: HTMLElement, panes: readonly Pane[], defaultPane?: string): void {
  if (panes.length === 0) return;

  const strip = el('div', { class: 'tabs' });
  const bodies = new Map<string, HTMLElement>();
  const mounted = new Set<string>();

  const paneFor = (hash: string): Pane | undefined => {
    // A hash can carry an argument for the pane — `#commands:sh.ss` opens the
    // catalogue on one command. The pane is everything before the colon.
    const wanted = hash.replace(/^#/, '').split(':')[0] ?? '';
    if (!wanted) return undefined;
    return panes.find((pane) => pane.id === wanted || (pane.alsoMatches ?? []).includes(wanted));
  };

  let active = paneFor(globalThis.location?.hash ?? '')?.id ?? defaultPane ?? panes[0]?.id ?? '';

  function show(id: string, updateHash = true): void {
    const pane = panes.find((p) => p.id === id);
    if (!pane) return;
    active = id;

    for (const tab of Array.from(strip.querySelectorAll<HTMLElement>('.tab'))) {
      tab.classList.toggle('active', tab.dataset['tab'] === id);
      tab.setAttribute('aria-selected', String(tab.dataset['tab'] === id));
    }

    for (const [paneId, body] of bodies) {
      // Explicit block rather than '': the stylesheet's own `.section` rule is
      // display:none, so clearing the inline style would hide the active pane.
      body.style.display = paneId === id ? 'block' : 'none';
    }

    // Lazily, and once. Building the catalogue on page load would slow down
    // the tab most people actually want.
    if (!mounted.has(id)) {
      const body = bodies.get(id);
      if (body) {
        mounted.add(id);
        try {
          pane.mount(body);
        } catch (error) {
          mounted.delete(id);
          clear(body);
          append(
            body,
            el('div', { class: 'tip warn' }, el('strong', { text: 'This tab could not be built. ' }), el('span', { text: String(error) })),
          );
        }
      }
    }

    if (updateHash && globalThis.location) {
      const url = new URL(globalThis.location.href);
      url.hash = id;
      globalThis.history?.replaceState(null, '', url.toString());
    }
  }

  for (const pane of panes) {
    append(
      strip,
      el('div', {
        class: `tab${pane.id === active ? ' active' : ''}`,
        text: pane.label,
        dataset: { tab: pane.id },
        attrs: { role: 'tab', tabindex: '0', 'aria-selected': String(pane.id === active) },
        on: {
          click: () => show(pane.id),
          keydown: (event) => {
            const key = (event as KeyboardEvent).key;
            if (key === 'Enter' || key === ' ') {
              event.preventDefault();
              show(pane.id);
            }
          },
        },
      }),
    );
  }

  const container = el('div', { class: 'tab-bodies' });
  for (const pane of panes) {
    const body = el('div', { class: 'tab-pane', attrs: { id: `pane-${pane.id}` } });
    body.style.display = 'none';
    bodies.set(pane.id, body);
    append(container, body);
  }

  clear(root);
  append(root, strip, container);

  // A hash typed or followed after load — including the redirect from the old
  // separate page — changes tab rather than doing nothing.
  globalThis.addEventListener?.('hashchange', () => {
    const wanted = paneFor(globalThis.location?.hash ?? '');
    if (wanted && wanted.id !== active) show(wanted.id, false);
  });

  show(active, false);
}
