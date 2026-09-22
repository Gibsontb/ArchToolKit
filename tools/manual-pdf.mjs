/**
 * Print the in-app manual to `docs/ArchToolKit-Manual.pdf`.
 *
 * The manual page is the single source: it is what the toolkit ships with and
 * what the pages link to, and this turns the same page into the PDF people
 * pass around. Run it whenever the manual changes — the page's own print
 * stylesheet already drops the navigation and the contents rail.
 *
 * Needs Playwright, which is a development-only convenience: without it the
 * script says so and exits quietly, exactly as the browser checks do.
 *
 *   node tools/manual-pdf.mjs [--port 8141]
 */

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TOOLS = dirname(fileURLToPath(import.meta.url));
const ROOT = join(TOOLS, '..');
const args = process.argv.slice(2);
const portArg = args.indexOf('--port');
const PORT = portArg >= 0 ? Number(args[portArg + 1]) : 8141;
const OUT = join(ROOT, 'docs', 'ArchToolKit-Manual.pdf');

let chromium;
try {
  chromium = createRequire(import.meta.url)('playwright').chromium;
} catch {
  try {
    chromium = createRequire(`${process.env.HOME}/`)('playwright').chromium;
  } catch {
    console.log('Playwright is not installed, so the manual PDF was not rebuilt.');
    console.log('  npm install --no-save playwright && npx playwright install chromium');
    process.exit(0);
  }
}

const server = spawn(process.execPath, [join(TOOLS, 'serve.mjs'), '--port', String(PORT), '--tries', '0'], {
  stdio: 'ignore',
  env: { ...process.env, NODE_NO_WARNINGS: '1' },
});
const stop = () => server.kill();
process.on('exit', stop);
process.on('SIGINT', () => {
  stop();
  process.exit(130);
});

await new Promise((r) => setTimeout(r, 1500));

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(`http://127.0.0.1:${PORT}/app/manual.html`, { waitUntil: 'networkidle' });
await page.emulateMedia({ media: 'print' });
await page.pdf({
  path: OUT,
  format: 'A4',
  printBackground: true,
  margin: { top: '16mm', bottom: '16mm', left: '14mm', right: '14mm' },
  displayHeaderFooter: true,
  headerTemplate: '<div></div>',
  footerTemplate:
    '<div style="width:100%;font-size:8px;color:#888;padding:0 14mm;display:flex;justify-content:space-between;">' +
    '<span>ArchToolKit manual — © 2026 Theodore Gibson. No warranty; every output is a draft for review.</span>' +
    '<span class="pageNumber"></span></div>',
});
await browser.close();
stop();

console.log(`Manual written to ${OUT}`);
