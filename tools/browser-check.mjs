#!/usr/bin/env node
/**
 * Drive the built pages in a real browser.
 *
 * The unit suite proves the domain logic; it cannot prove that a page mounts.
 * Two defects got through a green suite and a clean typecheck and were only
 * found here: a redraw triggered by the blur of clicking a button destroyed the
 * button mid-click, and a `let` declared after the code that reached it left the
 * spec builder dead on arrival whenever a handoff was present. Neither is
 * visible without a browser.
 *
 * Playwright is not a dependency of this project and cannot be, since the
 * toolkit has to build and run air-gapped. When it is absent this exits 0 and
 * says so: a check you cannot run is not a failure.
 *
 * Usage:  node tools/browser-check.mjs [--port 8140]
 */

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TOOLS = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const portArg = args.indexOf('--port');
const PORT = portArg >= 0 ? Number(args[portArg + 1]) : 8140;
const BASE = `http://127.0.0.1:${PORT}`;

let chromium;
try {
  chromium = createRequire(import.meta.url)('playwright').chromium;
} catch {
  try {
    chromium = createRequire(`${process.env.HOME}/`)('playwright').chromium;
  } catch {
    console.log('Playwright is not installed, so the browser checks were skipped.');
    console.log('  npm install --no-save playwright && npx playwright install chromium');
    process.exit(0);
  }
}

const server = spawn(
  process.execPath,
  [join(TOOLS, 'serve.mjs'), '--port', String(PORT), '--tries', '0'],
  { stdio: 'ignore', env: { ...process.env, NODE_NO_WARNINGS: '1' } },
);
const stop = () => server.kill();
process.on('exit', stop);
process.on('SIGINT', () => { stop(); process.exit(130); });

await new Promise((r) => setTimeout(r, 1500));

let failures = 0;
const check = (label, ok, detail = '') => {
  if (!ok) failures += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
};

const browser = await chromium.launch();

// --- every page mounts without a console error ----------------------------
for (const [name, path] of [
  ['index', '/'],
  ['inventory', '/app/inventory.html'],
  ['sizing', '/app/vcf-sizing.html'],
  ['spec', '/app/vcf-spec.html'],
]) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(BASE + path, { waitUntil: 'networkidle' });
  const text = (await page.locator('body').innerText()).length;
  check(`${name} mounts`, errors.length === 0 && text > 200, errors[0] ?? `${text} chars`);
  await ctx.close();
}

// --- editing a field must not break the buttons ---------------------------
{
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(`${BASE}/app/vcf-sizing.html`, { waitUntil: 'networkidle' });
  const hosts = page.locator('.field', { hasText: 'Hosts in mgmt cluster' }).locator('input').first();
  await hosts.fill('7');
  await hosts.dispatchEvent('change');
  await page.waitForTimeout(400);
  await page.locator('button', { hasText: 'Continue in the spec' }).click();
  await page.waitForTimeout(1500);
  check('a button still works after editing a field', page.url().endsWith('/vcf-spec.html'));

  const banner = await page.locator('text=Prefilled from your sizing').count();
  check('the spec builder receives the handoff', banner === 1);
  const carried = await page
    .locator('.field', { hasText: 'Host count' })
    .locator('input')
    .first()
    .inputValue();
  check('the host count carries across', carried === '7', `got ${carried}`);

  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(400);
  check(
    'reloading does not re-apply a spent handoff',
    (await page.locator('text=Prefilled from your sizing').count()) === 0,
  );
  await ctx.close();
}

// --- the pickers actually change the document -----------------------------
{
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(`${BASE}/app/vcf-spec.html`, { waitUntil: 'networkidle' });

  const scenario = page.locator('select').filter({ hasText: 'Deploy a new VCF fleet' }).first();
  await scenario.selectOption('new-vvf');
  await page.waitForTimeout(400);
  check(
    'vSphere Foundation drops NSX from the document',
    !/"nsxtSpec"/.test(await page.locator('body').innerText()),
  );
  await scenario.selectOption('new-vcf-fleet');
  await page.waitForTimeout(400);
  check(
    'a VCF scenario restores NSX',
    /"nsxtSpec"/.test(await page.locator('body').innerText()),
  );

  const storage = page.locator('select').filter({ hasText: 'vSAN ESA' }).first();
  await storage.selectOption('nfs');
  await page.waitForTimeout(400);
  check(
    'choosing NFS reveals the fields it needs',
    (await page.getByText('NFS servers', { exact: false }).count()) > 0,
  );
  await ctx.close();
}

await browser.close();
stop();

console.log(failures === 0 ? '\nBrowser checks passed.' : `\n${failures} browser check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
