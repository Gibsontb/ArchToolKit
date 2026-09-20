#!/usr/bin/env node
/**
 * ArchToolKit build — TypeScript to browser ESM, with no dependencies.
 *
 * Node cannot be assumed to have network access in the environments this
 * toolkit targets, so there is no bundler and no node_modules. Instead this
 * uses Node's own built-in TypeScript type stripper to emit plain ES modules
 * that a browser loads directly.
 *
 * What it does:
 *   1. Walks src/, skipping tests and test-only helpers.
 *   2. Strips type annotations (whitespace-preserving, so line numbers in
 *      stack traces still match the .ts source).
 *   3. Rewrites relative "./x.ts" import specifiers to "./x.js", because the
 *      browser will be loading the emitted files.
 *   4. Writes the result to web/lib/, mirroring the source tree.
 *
 * Usage:  node tools/build.mjs [--watch] [--clean]
 */

import { stripTypeScriptTypes } from 'node:module';
import { readdir, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, relative, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src');
const OUT = join(ROOT, 'web', 'lib');

/** Files and directories that never ship to the browser. */
const EXCLUDED_DIRS = new Set(['testing', '__fixtures__']);
const isTestFile = (name) => name.endsWith('.test.ts') || name.endsWith('.bench.ts');

/**
 * Declaration files describe other files; they have nothing to emit.
 * Stripping one produces an empty module with a name that looks like a real
 * one, which is confusing at best.
 */
const isDeclaration = (name) => name.endsWith('.d.ts');

/**
 * Rewrite relative TypeScript specifiers to their emitted JavaScript names.
 *
 * Matches the specifier position of static imports/exports (`from '...'`) and
 * dynamic `import('...')` only, so a string literal elsewhere in the code that
 * happens to end in `.ts` is left alone.
 */
function rewriteSpecifiers(code) {
  return code
    .replace(/(\bfrom\s*)(['"])(\.[^'"]*?)\.ts\2/g, '$1$2$3.js$2')
    .replace(/(\bimport\s*\(\s*)(['"])(\.[^'"]*?)\.ts\2/g, '$1$2$3.js$2')
    .replace(/(\bexport\s*\*\s*from\s*)(['"])(\.[^'"]*?)\.ts\2/g, '$1$2$3.js$2');
}

async function* walk(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry.name)) continue;
      yield* walk(full);
    } else if (entry.isFile()) {
      yield full;
    }
  }
}

async function buildFile(absPath) {
  const rel = relative(SRC, absPath);
  const name = rel.split(sep).pop() ?? '';

  // Non-TS assets (JSON data files, etc.) are copied through untouched so the
  // catalogs and sizing tables ship alongside the code.
  if (!name.endsWith('.ts')) {
    const dest = join(OUT, rel);
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, await readFile(absPath));
    return { rel, kind: 'copy' };
  }

  if (isTestFile(name) || isDeclaration(name)) return null;

  const source = await readFile(absPath, 'utf8');
  let stripped;
  try {
    stripped = stripTypeScriptTypes(source, { mode: 'strip', sourceMap: false });
  } catch (err) {
    throw new Error(`Failed to strip types in ${rel}: ${err.message}`);
  }

  const code = rewriteSpecifiers(stripped);
  const dest = join(OUT, rel.replace(/\.ts$/, '.js'));
  await mkdir(dirname(dest), { recursive: true });
  await writeFile(dest, code, 'utf8');
  return { rel, kind: 'build' };
}

async function build({ quiet = false } = {}) {
  const started = Date.now();
  let built = 0;
  let copied = 0;
  const errors = [];

  for await (const file of walk(SRC)) {
    try {
      const result = await buildFile(file);
      if (!result) continue;
      if (result.kind === 'build') built += 1;
      else copied += 1;
    } catch (err) {
      errors.push(err.message);
    }
  }

  if (errors.length > 0) {
    for (const message of errors) console.error(`  ✗ ${message}`);
    console.error(`\nBuild failed with ${errors.length} error(s).`);
    process.exitCode = 1;
    return false;
  }

  if (!quiet) {
    const ms = Date.now() - started;
    console.log(`Built ${built} module(s), copied ${copied} asset(s) to web/lib in ${ms}ms`);
  }
  return true;
}

async function clean() {
  if (existsSync(OUT)) {
    await rm(OUT, { recursive: true, force: true });
    console.log('Cleaned web/lib');
  }
}

async function watch() {
  const { watch: fsWatch } = await import('node:fs');
  await build();
  console.log('Watching src/ for changes… (Ctrl-C to stop)');

  let timer = null;
  fsWatch(SRC, { recursive: true }, (_event, filename) => {
    if (!filename) return;
    // Debounce: editors often fire several events for one save.
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const ok = await build({ quiet: true });
      const stamp = new Date().toLocaleTimeString();
      console.log(ok ? `  ${stamp}  rebuilt (${filename})` : `  ${stamp}  build failed`);
    }, 60);
  });
}

const args = new Set(process.argv.slice(2));

if (!existsSync(SRC)) {
  console.error(`No src/ directory at ${SRC}`);
  process.exit(1);
}

if (args.has('--clean')) await clean();
if (args.has('--watch')) await watch();
else await build();

