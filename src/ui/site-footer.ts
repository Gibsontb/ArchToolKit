/**
 * The two things every page says about the toolkit itself: which version it
 * is, at the top beside the brand, and the licence, on one line across the
 * bottom.
 *
 * The footer is a row rather than a paragraph — a block of legal text at the
 * bottom of a working tool costs four lines and gets scrolled past, while a
 * single line across the width is read once and stays out of the way. It links
 * to the manual's licence section for the full terms.
 */

import { VERSION, VERSION_LABEL } from '../kit/version.ts';

const AUTHOR = 'Theodore Gibson';
const YEAR = '2026';

/** The manual lives at `app/manual.html`; pages sit beside it, the home page above it. */
function manualHref(): string {
  const path = typeof globalThis.location === 'undefined' ? '' : globalThis.location.pathname;
  return /\/app\//.test(path) ? 'manual.html#licence' : 'app/manual.html#licence';
}

/**
 * The version goes inside the brand, on a line of its own beneath the name,
 * rather than beside it in the header: the navigation is eleven links wide and
 * a badge next to the brand pushes it onto a second row on a laptop screen.
 */
export function mountVersion(header: Element): HTMLElement {
  const badge = document.createElement('span');
  badge.className = 'version-badge';
  badge.setAttribute('data-control', 'version');
  badge.textContent = VERSION_LABEL;

  const brand = header.querySelector('.brand');
  const name = brand?.querySelector(':scope > span:not(.brand-mark)');
  if (brand && name) {
    // The name and the version become one column beside the mark, so the brand
    // stays as wide as its longest line rather than as wide as both together.
    const column = document.createElement('span');
    column.className = 'brand-text';
    brand.insertBefore(column, name);
    column.appendChild(name);
    column.appendChild(badge);
  } else {
    (brand ?? header).appendChild(badge);
  }
  return badge;
}

export function mountSiteFooter(host: Element): HTMLElement {
  const footer = document.createElement('footer');
  footer.className = 'site-footer';
  footer.setAttribute('data-control', 'site-footer');

  const parts: (string | HTMLElement)[] = [
    `ArchToolKit ${VERSION}`,
    `© ${YEAR} ${AUTHOR}, all rights reserved`,
    'Free to use as supplied; no copying, modifying or selling',
    'No warranty, no liability',
    'Every output is a draft to review, not advice',
  ];

  for (const part of parts) {
    const span = document.createElement('span');
    if (typeof part === 'string') span.textContent = part;
    else span.appendChild(part);
    footer.appendChild(span);
  }

  const link = document.createElement('a');
  link.href = manualHref();
  link.textContent = 'Licence and disclaimer';
  const last = document.createElement('span');
  last.appendChild(link);
  footer.appendChild(last);

  host.appendChild(footer);
  return footer;
}

if (typeof document !== 'undefined') {
  const header = document.querySelector('.app-header');
  if (header && !header.querySelector('[data-control="version"]')) mountVersion(header);

  const host = document.querySelector('main') ?? document.body;
  if (host && !host.querySelector('[data-control="site-footer"]')) mountSiteFooter(host);
}
