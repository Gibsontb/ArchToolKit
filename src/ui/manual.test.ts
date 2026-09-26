/**
 * The manual has to keep up with the toolkit.
 *
 * A page added, renamed or removed without the manual changing leaves the
 * manual quietly wrong, which is worse than having none: someone reads it and
 * believes it. So this checks the manual against the pages that actually
 * exist, rather than against a list someone has to remember to update.
 *
 * What it enforces:
 *   - every page in `web/app/` (bar the manual itself and the redirects) is
 *     named in the manual's page table and has a section of its own;
 *   - the contents list and the sections agree, and the sections are numbered
 *     in order with no gaps;
 *   - every anchor the manual links to internally exists;
 *   - the licence section is present, because every page's footer links to it.
 *
 * When this fails, the fix is to write the manual entry — not to relax the
 * test.
 */

import { describe, it } from 'node:test';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from '../testing/expect.ts';

const web = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'web');
const manual = readFileSync(join(web, 'app', 'manual.html'), 'utf8');

/** A page that only forwards somewhere else needs no manual entry. */
function isRedirect(html: string): boolean {
  return /http-equiv="refresh"/.test(html) || /location\.replace\(/.test(html);
}

const pages = readdirSync(join(web, 'app'))
  .filter((name) => name.endsWith('.html') && name !== 'manual.html')
  .filter((name) => !isRedirect(readFileSync(join(web, 'app', name), 'utf8')));

const sections = [...manual.matchAll(/<h2 id="([^"]+)">(\d+)\.\s*([^<]+)<\/h2>/g)].map((m) => ({
  id: m[1] as string,
  number: Number(m[2]),
  title: (m[3] as string).trim(),
}));

describe('the manual', () => {
  it('has a section for every page, and links to it in the page table', () => {
    const missing = pages.filter((page) => !manual.includes(`href="${page}"`));
    expect(missing).toEqual([]);
  });

  it('mentions every page more than once: the table, and again where it is explained', () => {
    // One mention is a page listed and never described. Two or more means the
    // manual says something about it beyond its name.
    const thin = pages.filter((page) => manual.split(`href="${page}"`).length - 1 < 2);
    expect(thin).toEqual([]);
  });

  it('numbers its sections in order, with no gaps and no repeats', () => {
    expect(sections.length > 5).toBe(true);
    expect(sections.map((s) => s.number)).toEqual(sections.map((_, i) => i + 1));
  });

  it('lists every section in the contents, and nothing that is not there', () => {
    const contents = [...manual.matchAll(/<li><a href="#([^"]+)">/g)].map((m) => m[1]);
    expect(contents).toEqual(sections.map((s) => s.id));
  });

  it('has no internal link pointing at an anchor that does not exist', () => {
    const anchors = new Set([...manual.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1] as string));
    const broken = [...manual.matchAll(/href="#([^"]+)"/g)].map((m) => m[1] as string).filter((target) => !anchors.has(target));
    expect(broken).toEqual([]);
  });

  it('carries the licence section every page footer links to', () => {
    expect(sections.some((s) => s.id === 'licence')).toBe(true);
    expect(/no warranty/i.test(manual)).toBe(true);
    expect(manual.includes('Theodore Gibson')).toBe(true);
  });
});

describe('every page', () => {
  const shells = pages.map((name) => ({ name, html: readFileSync(join(web, 'app', name), 'utf8') }));

  it('links to the manual from its navigation', () => {
    const missing = shells.filter(({ html }) => !html.includes('manual.html')).map((s) => s.name);
    expect(missing).toEqual([]);
  });

  it('carries the Clear all button and the licence footer', () => {
    const missing = shells.filter(({ html }) => !html.includes('clear-all.js') || !html.includes('site-footer.js')).map((s) => s.name);
    expect(missing).toEqual([]);
  });

  it('does not link to a page that no longer exists', () => {
    const existing = new Set(readdirSync(join(web, 'app')));
    const broken: string[] = [];
    for (const { name, html } of shells) {
      for (const match of html.matchAll(/href="([a-z0-9-]+\.html)"/g)) {
        if (!existing.has(match[1] as string)) broken.push(`${name} → ${match[1]}`);
      }
    }
    expect(broken).toEqual([]);
  });
});
