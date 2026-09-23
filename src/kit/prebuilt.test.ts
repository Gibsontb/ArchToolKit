/**
 * The committed build matches the source.
 *
 * web/lib is committed on purpose: a copy of the repository downloaded as a
 * ZIP onto a machine with no Node is served as it stands, by tools/serve.ps1.
 * That only works if what is committed is what the source says. A source
 * change committed without a build ships the old page to every machine that
 * cannot build, and nothing there would say so.
 *
 * So this rebuilds each file in memory, exactly as tools/build.mjs does, and
 * compares. When it fails, the fix is `npm run build` before committing.
 */

import { describe, it } from 'node:test';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripTypeScriptTypes } from 'node:module';
import { expect } from '../testing/expect.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = join(ROOT, 'src');
const OUT = join(ROOT, 'web', 'lib');
const EXCLUDED = new Set(['testing', '__fixtures__']);

function sources(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!EXCLUDED.has(entry.name)) found.push(...sources(full));
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') && !entry.name.endsWith('.bench.ts') && !entry.name.endsWith('.d.ts')) {
      found.push(full);
    }
  }
  return found;
}

function built(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...built(full));
    else if (entry.name.endsWith('.js')) found.push(full);
  }
  return found;
}

/** The same rewrite tools/build.mjs applies after stripping types. */
function rewriteSpecifiers(code: string): string {
  return code
    .replace(/(\bfrom\s*)(['"])(\.[^'"]*?)\.ts\2/g, '$1$2$3.js$2')
    .replace(/(\bimport\s*\(\s*)(['"])(\.[^'"]*?)\.ts\2/g, '$1$2$3.js$2')
    .replace(/(\bexport\s*\*\s*from\s*)(['"])(\.[^'"]*?)\.ts\2/g, '$1$2$3.js$2');
}

const lf = (text: string): string => text.replace(/\r\n/g, '\n');

describe('the committed build in web/lib', () => {
  it('matches the source, so a machine with no Node gets the current pages', () => {
    const stale: string[] = [];
    for (const file of sources(SRC)) {
      const rel = relative(SRC, file);
      const dest = join(OUT, rel.replace(/\.ts$/, '.js'));
      if (!existsSync(dest)) {
        stale.push(`${rel}: not built`);
        continue;
      }
      const expected = lf(rewriteSpecifiers(stripTypeScriptTypes(readFileSync(file, 'utf8'), { mode: 'strip' })));
      if (lf(readFileSync(dest, 'utf8')) !== expected) stale.push(`${rel}: out of date`);
    }
    if (stale.length > 0) stale.unshift('Run `npm run build` and commit web/lib:');
    expect(stale).toEqual([]);
  });

  it('has nothing left over from a source file that no longer exists', () => {
    // Plain .js files under src (the data catalogues) are copied through as they
    // are, so a .js in web/lib is accounted for by a .ts or a .js of the same name.
    const orphans = built(OUT)
      .map((file) => relative(OUT, file))
      .filter((rel) => !existsSync(join(SRC, rel.replace(/\.js$/, '.ts'))) && !existsSync(join(SRC, rel)))
      .map((rel) => rel.split(sep).join('/'));
    expect(orphans).toEqual([]);
  });
});
