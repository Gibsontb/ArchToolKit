#!/usr/bin/env node
/**
 * Refresh the VCF sizing figures from Broadcom's Planning and Preparation
 * Workbook — the only place several appliance sizes are published (NSX
 * Manager, SDDC Manager, VCF Automation per size, VCF management services,
 * cloud proxy disk, the Operations for Networks collector, the vSAN witness).
 *
 *   npm run vcf:workbook              # every workbook the 9.1 page links
 *   npm run vcf:workbook -- --file x.xlsx --release 9.1.1
 *
 * Finds the workbooks on the TechDocs "Planning and Preparation" page, reads
 * each one with the toolkit's own xlsx reader (no Excel, no Python), and
 * writes src/vcf/workbook-data.ts: per release, the "Lookup Tables" of the
 * Static Reference Tables sheet as { table: { key: number | string } }. That
 * file is committed so the toolkit works air-gapped; the workbook itself is
 * Broadcom's and is not kept.
 *
 * Only facts are kept — the figures, keyed as the workbook keys them — and
 * the release, source URL and fetch date, so sizing-data.ts can cite them as
 * published. Needs network access to techdocs.broadcom.com.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openXlsx } from '../src/core/xlsx.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', 'src', 'vcf', 'workbook-data.ts');
const PAGE = 'https://techdocs.broadcom.com/us/en/vmware-cis/vcf/vcf-9-0-and-later/9-1/planning-and-preparation.html';
const ASSET_BASE = 'https://techdocs.broadcom.com/content/dam/broadcom/techdocs/us/en/assets/vmware-cis/vcf/';
const SHEET = 'Static Reference Tables';

const argv = process.argv.slice(2);
const arg = (flag) => {
  const at = argv.indexOf(flag);
  return at >= 0 ? argv[at + 1] : undefined;
};

async function get(url, binary = false) {
  for (let attempt = 1; ; attempt++) {
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (vcf-workbook refresh)' } });
    if (r.ok) return binary ? new Uint8Array(await r.arrayBuffer()) : r.text();
    if ((r.status === 429 || r.status >= 500) && attempt < 6) {
      await new Promise((done) => setTimeout(done, 2000 * attempt));
      continue;
    }
    throw new Error(`${url}: HTTP ${r.status}`);
  }
}

/** Every workbook the page links, as { release, url }. */
async function findWorkbooks() {
  const html = await get(PAGE);
  const found = new Map();
  for (const m of html.matchAll(/vcf-([0-9.]+?)-planning-and-preparation-workbook[^"'\s>]*\.xlsx/g)) {
    const release = m[1];
    if (!found.has(release)) found.set(release, `${ASSET_BASE}${m[0]}`);
  }
  if (found.size === 0) throw new Error(`No workbook linked from ${PAGE} — the page layout changed; pass --file and --release.`);
  return [...found].map(([release, url]) => ({ release, url }));
}

const asValue = (text) => {
  const t = String(text ?? '').trim();
  return /^-?\d+(\.\d+)?$/.test(t) ? Number(t) : t;
};

const isNumber = (text) => /^-?\d+(\.\d+)?$/.test(String(text).trim());

/**
 * The Lookup Tables. A table starts at a header row, in one of three forms the
 * workbook uses:
 *   "<table> | Value"                    → <table>
 *   "<table>" alone, when it is a phrase → <table>
 *   "<name> | CPU" (or RAM, Disk)        → "<name> CPU" — inside the VCFMS
 *     calculations, where the name repeats an appliance table's
 *     ("Identity Broker CPU"), it becomes "<name> CPU (VCFMS)"
 * and each "<key> | <value>" row after it belongs to it. A row of three or
 * more cells is some other structure (the CIDR table, a calculation grid) and
 * ends the table, so its rows are never read as the previous table's values.
 */
async function lookupTables(bytes) {
  const wb = await openXlsx(bytes);
  if (!wb.sheets.includes(SHEET)) throw new Error(`The workbook has no "${SHEET}" sheet (it has: ${wb.sheets.join(', ')}).`);
  const tables = {};
  let started = false;
  let current = null;
  let inVcfms = false;
  const open = (name) => {
    const taken = Object.hasOwn(tables, name);
    current = taken && inVcfms ? `${name} (VCFMS)` : name;
    tables[current] ??= {};
  };
  await wb.rows(SHEET, (cells) => {
    const row = cells.map((c) => String(c ?? '').trim()).filter((c) => c !== '');
    if (!started) {
      if (row[0] === 'Lookup Tables') started = true;
      return;
    }
    if (row.length === 0) return;
    if (row[0].startsWith('VCFMS Calculations')) inVcfms = true;
    if (row.length >= 3) {
      current = null;
      return;
    }
    if (row.length === 1) {
      // A lone phrase ("Log Managment RAM Per Replica") is a header; a lone
      // single word inside a table ("Tinylstorage") is a key whose value is blank.
      if (!isNumber(row[0]) && (/\s/.test(row[0]) || !current)) open(row[0]);
      return;
    }
    if (row[1] === 'Value') return open(row[0]);
    if (['CPU', 'RAM', 'Disk'].includes(row[1]) && !isNumber(row[0])) return open(`${row[0]} ${row[1]}`);
    if (current) tables[current][row[0]] = asValue(row[1]);
  });
  // A header with no rows under it (a calculation block's title) is not a table.
  for (const [name, rows] of Object.entries(tables)) if (Object.keys(rows).length === 0) delete tables[name];
  if (Object.keys(tables).length === 0) throw new Error('No lookup tables found — the sheet layout changed.');
  return tables;
}

const sources = [];
if (arg('--file')) {
  if (!arg('--release')) throw new Error('--file needs --release');
  sources.push({ release: arg('--release'), url: arg('--file'), local: true });
} else {
  sources.push(...(await findWorkbooks()));
}

const releases = {};
for (const source of sources) {
  process.stdout.write(`VCF ${source.release} workbook… `);
  const bytes = source.local ? new Uint8Array(readFileSync(source.url)) : await get(source.url, true);
  const tables = await lookupTables(bytes);
  releases[source.release] = { source: source.local ? `${ASSET_BASE}vcf-${source.release}-planning-and-preparation-workbook.xlsx` : source.url, tables };
  console.log(`${Object.keys(tables).length} tables`);
}

// Keep releases the page no longer links (an older workbook still sizes an older release).
let previous = {};
try {
  const m = /export const WORKBOOK: WorkbookData = (\{[\s\S]*\});\s*$/.exec(readFileSync(OUT, 'utf8'));
  if (m) previous = JSON.parse(m[1]).releases ?? {};
} catch {
  /* first run */
}
const merged = { ...previous, ...releases };
const fetchedAt = new Date().toISOString().slice(0, 10);

writeFileSync(
  OUT,
  `/**
 * Figures from Broadcom's VCF Planning and Preparation Workbook — GENERATED by
 * tools/fetch-vcf-workbook.mjs (npm run vcf:workbook), do not edit by hand.
 *
 * Per release: the "Lookup Tables" of the "${SHEET}" sheet, keyed exactly as
 * the workbook keys them (e.g. tables["SDDC Manager"].CPU). sizing-data.ts
 * reads these and cites them as published.
 */

export interface WorkbookRelease {
  readonly source: string;
  readonly tables: Readonly<Record<string, Readonly<Record<string, number | string>>>>;
}

export interface WorkbookData {
  readonly fetchedAt: string;
  readonly page: string;
  readonly releases: Readonly<Record<string, WorkbookRelease>>;
}

export const WORKBOOK: WorkbookData = ${JSON.stringify({ fetchedAt, page: PAGE, releases: merged }, null, 1)};
`,
);
console.log(`Wrote ${OUT} (${Object.keys(merged).length} release(s)).`);
