/**
 * The one line at the bottom of every page: who wrote it, what it is free to
 * be used for, and the fact that the output is a draft rather than an answer.
 *
 * It mounts itself into `main` on every page, after everything else, and links
 * to the licence section of the manual for the full text. It is deliberately
 * quiet — a page of legal text at the bottom of a working tool gets scrolled
 * past — but it is present everywhere, which is the point.
 */

const AUTHOR = 'Theodore Gibson';
const YEAR = '2026';

/** The manual lives at `app/manual.html`; pages sit beside it, the home page above it. */
function manualHref(): string {
  const path = typeof globalThis.location === 'undefined' ? '' : globalThis.location.pathname;
  return /\/app\//.test(path) ? 'manual.html#licence' : 'app/manual.html#licence';
}

export function mountSiteFooter(host: Element): HTMLElement {
  const footer = document.createElement('footer');
  footer.className = 'site-footer';
  footer.setAttribute('data-control', 'site-footer');

  const line = document.createElement('p');
  line.append(`ArchToolKit © ${YEAR} ${AUTHOR}. Free to use, copy and modify, with no warranty and no liability. `);
  line.append('Everything it produces — sizing, specifications, configuration, code, migration routes — is a draft for you to review, not advice and not a finished artefact. ');

  const link = document.createElement('a');
  link.href = manualHref();
  link.textContent = 'Licence and disclaimer';
  line.append(link);
  line.append('.');

  footer.appendChild(line);
  host.appendChild(footer);
  return footer;
}

const host = typeof document === 'undefined' ? null : (document.querySelector('main') ?? document.body);
if (host && !host.querySelector('[data-control="site-footer"]')) mountSiteFooter(host);
