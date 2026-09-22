/**
 * The portfolio: every application that has been evaluated, kept.
 *
 * The old pair of pages lost this — you evaluated an application, exported a
 * JSON record, and re-imported it on a separate dashboard. Here the two are
 * the same page and the record is kept in this browser, so the portfolio is
 * simply what you have evaluated so far. Re-evaluating an application you
 * already have replaces it rather than adding a second row, matched on its
 * name, because that is what people mean by evaluating it again.
 *
 * Three ways in: evaluating one here, importing a CSV inventory (which makes
 * draft rows with default ratings, to be refined one at a time), and importing
 * a JSON portfolio exported from this page or the previous toolkit. Two ways
 * out: CSV for a spreadsheet, JSON to carry between browsers.
 *
 * It lives in this browser only, and "Clear all" removes it with everything
 * else.
 */

import { run } from '../kit/idb.ts';
import type { Finding } from '../core/findings.ts';
import { CLOUDS, type Cloud, type Criticality } from './options.ts';
import { evaluate } from './evaluate.ts';
import type { ServiceCatalog } from './services.ts';
import { DEFAULT_RATINGS, EMPTY_APPLICATION, NO_GATES, type Application, type Gates, type PortfolioEntry, type Ratings } from './types.ts';

const KEY = 'applications';

/** The columns a CSV import reads, and the ones an inventory export writes. */
export const CSV_COLUMNS = [
  'name',
  'owner',
  'criticality',
  'rtoHours',
  'rpoHours',
  'workloadType',
  'enterpriseStandardCloud',
  'primaryStack',
  'osRuntime',
  'database',
  'vendor',
  'integrationCount',
  'dataSizeGb',
  'identity',
  'compliance',
  'dataSovereigntyRequired',
  'notes',
] as const;

export const CSV_TEMPLATE = `${CSV_COLUMNS.join(',')}\n`;

/* -------------------------------------------------------------------------- *
 * Storage
 * -------------------------------------------------------------------------- */

export async function loadPortfolio(): Promise<PortfolioEntry[]> {
  const stored = await run<PortfolioEntry[]>('portfolio', 'readonly', (store) => store.get(KEY) as IDBRequest<PortfolioEntry[]>);
  return Array.isArray(stored) ? stored : [];
}

/** Resolves false when the browser will not keep it, so the page can say so. */
export async function savePortfolio(entries: readonly PortfolioEntry[]): Promise<boolean> {
  const ok = await run('portfolio', 'readwrite', (store) => store.put([...entries], KEY));
  return ok !== null;
}

export async function clearPortfolio(): Promise<void> {
  await run('portfolio', 'readwrite', (store) => store.delete(KEY));
}

const slug = (name: string): string =>
  String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'application';

/** An application's identity is its name: evaluating it again replaces the row. */
export function entryFor(app: Application, catalog?: ServiceCatalog, draft = false): PortfolioEntry {
  return {
    id: slug(app.name),
    application: app,
    evaluation: evaluate(app, catalog),
    evaluatedAt: new Date().toISOString(),
    draft,
  };
}

/** Add or replace, keeping the order the rows were first added in. */
export function upsert(entries: readonly PortfolioEntry[], entry: PortfolioEntry): PortfolioEntry[] {
  const index = entries.findIndex((e) => e.id === entry.id);
  if (index < 0) return [...entries, entry];
  const out = [...entries];
  out[index] = entry;
  return out;
}

export function remove(entries: readonly PortfolioEntry[], id: string): PortfolioEntry[] {
  return entries.filter((e) => e.id !== id);
}

/** Every record evaluated again, after a rule or a rating has changed. */
export function reevaluate(entries: readonly PortfolioEntry[], catalog?: ServiceCatalog): PortfolioEntry[] {
  return entries.map((entry) => ({ ...entry, evaluation: evaluate(entry.application, catalog) }));
}

/* -------------------------------------------------------------------------- *
 * CSV
 * -------------------------------------------------------------------------- */

/** A CSV reader that handles quoted fields, embedded commas and CRLF. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const source = String(text ?? '').replace(/^﻿/, '');

  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (quoted) {
      if (ch === '"') {
        if (source[i + 1] === '"') {
          field += '"';
          i += 1;
        } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && source[i + 1] === '\n') i += 1;
      row.push(field);
      field = '';
      if (row.some((c) => c.trim() !== '')) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((c) => c.trim() !== '')) rows.push(row);
  return rows;
}

function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

const CRITICALITIES: Criticality[] = ['Low', 'Medium', 'High', 'Mission Critical'];

function asCriticality(value: string): Criticality {
  const wanted = String(value ?? '').trim().toLowerCase();
  return CRITICALITIES.find((c) => c.toLowerCase() === wanted) ?? EMPTY_APPLICATION.criticality;
}

function asCloud(value: string): Cloud | '' {
  const wanted = String(value ?? '').trim().toLowerCase();
  if (!wanted || wanted === 'none' || wanted === '(none)') return '';
  return (CLOUDS as readonly string[]).includes(wanted) ? (wanted as Cloud) : '';
}

function asNumber(value: unknown, fallback: number): number {
  const n = Number(String(value ?? '').replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) && String(value ?? '').trim() !== '' ? n : fallback;
}

function asFlag(value: unknown): boolean {
  return /^(y|yes|true|1)$/i.test(String(value ?? '').trim());
}

/**
 * One CSV row as an application, with default ratings.
 *
 * A row is a draft: the intake questions a spreadsheet cannot answer — the six
 * ratings and the hard gates — are left at their defaults, and the row is
 * marked so the page can say which records still need a person.
 */
export function applicationFromRow(row: Readonly<Record<string, string>>): Application {
  const gates: Gates = { ...NO_GATES, dataSovereigntyRequired: asFlag(row['dataSovereigntyRequired']) };
  return {
    ...EMPTY_APPLICATION,
    name: String(row['name'] ?? '').trim(),
    owner: String(row['owner'] ?? '').trim(),
    criticality: asCriticality(row['criticality'] ?? ''),
    rtoHours: asNumber(row['rtoHours'], EMPTY_APPLICATION.rtoHours),
    rpoHours: asNumber(row['rpoHours'], EMPTY_APPLICATION.rpoHours),
    workloadType: String(row['workloadType'] ?? '').trim() || EMPTY_APPLICATION.workloadType,
    enterpriseStandardCloud: asCloud(row['enterpriseStandardCloud'] ?? ''),
    primaryStack: String(row['primaryStack'] ?? '').trim(),
    osRuntime: String(row['osRuntime'] ?? '').trim(),
    database: String(row['database'] ?? '').trim(),
    vendor: String(row['vendor'] ?? '').trim(),
    integrationCount: asNumber(row['integrationCount'], EMPTY_APPLICATION.integrationCount),
    dataSizeGb: asNumber(row['dataSizeGb'], EMPTY_APPLICATION.dataSizeGb),
    identity: String(row['identity'] ?? '').trim(),
    notes: String(row['notes'] ?? '').trim(),
    compliance: String(row['compliance'] ?? '')
      .split(/[;,]/)
      .map((c) => c.trim())
      .filter(Boolean),
    gates,
    ratings: DEFAULT_RATINGS,
  };
}

export interface ImportResult {
  readonly entries: readonly PortfolioEntry[];
  readonly findings: readonly Finding[];
}

/** A CSV inventory as draft portfolio rows, with a finding for each row skipped. */
export function importCsv(text: string, catalog?: ServiceCatalog): ImportResult {
  const rows = parseCsv(text);
  const findings: Finding[] = [];
  if (rows.length === 0) {
    return { entries: [], findings: [{ severity: 'error', code: 'migration.csv.empty', message: 'That file has no rows.', source: 'portfolio' }] };
  }

  const header = (rows[0] as string[]).map((h) => h.trim());
  const known = header.filter((h) => (CSV_COLUMNS as readonly string[]).includes(h));
  if (!known.includes('name')) {
    return {
      entries: [],
      findings: [
        {
          severity: 'error',
          code: 'migration.csv.no-name-column',
          message: 'The first row must be a header, and it must include a "name" column.',
          remediation: `Expected columns: ${CSV_COLUMNS.join(', ')}`,
          source: 'portfolio',
        },
      ],
    };
  }
  for (const column of header) {
    if (column && !(CSV_COLUMNS as readonly string[]).includes(column)) {
      findings.push({ severity: 'info', code: 'migration.csv.extra-column', message: `Column "${column}" is not one this page reads; it was ignored.`, source: 'portfolio' });
    }
  }

  const entries: PortfolioEntry[] = [];
  const seen = new Set<string>();
  for (let i = 1; i < rows.length; i += 1) {
    const cells = rows[i] as string[];
    const row: Record<string, string> = {};
    header.forEach((column, index) => {
      row[column] = cells[index] ?? '';
    });
    const app = applicationFromRow(row);
    if (!app.name) {
      findings.push({ severity: 'warning', code: 'migration.csv.no-name', message: `Row ${i + 1} has no name, so it was skipped.`, path: `row ${i + 1}`, source: 'portfolio' });
      continue;
    }
    const entry = entryFor(app, catalog, true);
    if (seen.has(entry.id)) {
      findings.push({
        severity: 'warning',
        code: 'migration.csv.duplicate',
        message: `"${app.name}" appears more than once; the last row wins.`,
        path: `row ${i + 1}`,
        source: 'portfolio',
      });
    }
    seen.add(entry.id);
    const at = entries.findIndex((e) => e.id === entry.id);
    if (at < 0) entries.push(entry);
    else entries[at] = entry;
  }

  if (entries.length === 0 && findings.every((f) => f.severity !== 'error')) {
    findings.push({ severity: 'error', code: 'migration.csv.nothing-read', message: 'No rows could be read from that file.', source: 'portfolio' });
  } else {
    findings.unshift({
      severity: 'info',
      code: 'migration.csv.imported',
      message: `${entries.length} application${entries.length === 1 ? '' : 's'} imported as drafts. Their ratings are the defaults until you evaluate each one.`,
      source: 'portfolio',
    });
  }
  return { entries, findings };
}

/** The portfolio as a spreadsheet: the intake, then what the evaluation made of it. */
export function exportCsv(entries: readonly PortfolioEntry[], waveOf?: (entry: PortfolioEntry) => string): string {
  const header = [...CSV_COLUMNS, 'readiness', 'route', 'targetCloud', 'risk', 'wave', 'draft', 'evaluatedAt'];
  const lines = [header.join(',')];
  for (const entry of entries) {
    const app = entry.application;
    const evaluation = entry.evaluation;
    const row = [
      app.name,
      app.owner,
      app.criticality,
      app.rtoHours,
      app.rpoHours,
      app.workloadType,
      app.enterpriseStandardCloud,
      app.primaryStack,
      app.osRuntime,
      app.database,
      app.vendor,
      app.integrationCount,
      app.dataSizeGb,
      app.identity,
      app.compliance.join(';'),
      app.gates.dataSovereigntyRequired ? 'yes' : 'no',
      app.notes,
      evaluation.readiness,
      evaluation.route,
      evaluation.cloud.toUpperCase(),
      evaluation.risk,
      waveOf ? waveOf(entry) : '',
      entry.draft ? 'yes' : 'no',
      entry.evaluatedAt,
    ];
    lines.push(row.map(csvCell).join(','));
  }
  return `${lines.join('\n')}\n`;
}

/* -------------------------------------------------------------------------- *
 * JSON
 * -------------------------------------------------------------------------- */

export interface PortfolioFile {
  readonly kind: 'archtoolkit.migration-portfolio';
  readonly version: 1;
  readonly exportedAt: string;
  readonly applications: readonly PortfolioEntry[];
}

export function exportJson(entries: readonly PortfolioEntry[]): string {
  const file: PortfolioFile = {
    kind: 'archtoolkit.migration-portfolio',
    version: 1,
    exportedAt: new Date().toISOString(),
    applications: [...entries],
  };
  return `${JSON.stringify(file, null, 2)}\n`;
}

function ratingsFrom(value: unknown): Ratings {
  const source = (value ?? {}) as Record<string, unknown>;
  const read = (key: keyof Ratings): number => {
    const n = Number(source[key]);
    return Number.isFinite(n) && n >= 1 && n <= 5 ? n : DEFAULT_RATINGS[key];
  };
  return {
    cloudCompatibility: read('cloudCompatibility'),
    technicalDebt: read('technicalDebt'),
    vendorLockRisk: read('vendorLockRisk'),
    complianceComplexity: read('complianceComplexity'),
    architectureModularity: read('architectureModularity'),
    refactorEffort: read('refactorEffort'),
  };
}

function gatesFrom(value: unknown): Gates {
  const source = (value ?? {}) as Record<string, unknown>;
  const read = (key: keyof Gates): boolean => source[key] === true || asFlag(source[key]);
  return {
    isObsolete: read('isObsolete'),
    vendorSaaSAvailable: read('vendorSaaSAvailable'),
    mustStayOnPrem: read('mustStayOnPrem'),
    hardwareBound: read('hardwareBound'),
    mainframeBound: read('mainframeBound'),
    dataSovereigntyRequired: read('dataSovereigntyRequired'),
  };
}

/** One application from whatever shape the JSON is in, evaluated fresh. */
export function applicationFrom(value: unknown): Application | null {
  if (!value || typeof value !== 'object') return null;
  const source = value as Record<string, unknown>;
  // A portfolio entry, a single exported record, or a bare application.
  const app = (source['application'] ?? source['app'] ?? source) as Record<string, unknown>;
  const name = String(app['name'] ?? '').trim();
  if (!name) return null;

  const compliance = Array.isArray(app['compliance'])
    ? (app['compliance'] as unknown[]).map((c) => String(c).trim()).filter(Boolean)
    : String(app['compliance'] ?? '')
        .split(/[;,]/)
        .map((c) => c.trim())
        .filter(Boolean);

  return {
    ...EMPTY_APPLICATION,
    name,
    owner: String(app['owner'] ?? ''),
    criticality: asCriticality(String(app['criticality'] ?? '')),
    rtoHours: asNumber(app['rtoHours'], EMPTY_APPLICATION.rtoHours),
    rpoHours: asNumber(app['rpoHours'], EMPTY_APPLICATION.rpoHours),
    workloadType: String(app['workloadType'] ?? EMPTY_APPLICATION.workloadType),
    enterpriseStandardCloud: asCloud(String(app['enterpriseStandardCloud'] ?? '')),
    primaryStack: String(app['primaryStack'] ?? ''),
    osRuntime: String(app['osRuntime'] ?? ''),
    database: String(app['database'] ?? ''),
    hostingPlatform: String(app['hostingPlatform'] ?? ''),
    integrationTypes: String(app['integrationTypes'] ?? ''),
    architecturePattern: String(app['architecturePattern'] ?? ''),
    vendor: String(app['vendor'] ?? ''),
    integrationCount: asNumber(app['integrationCount'], EMPTY_APPLICATION.integrationCount),
    dataSizeGb: asNumber(app['dataSizeGb'], EMPTY_APPLICATION.dataSizeGb),
    identity: String(app['identity'] ?? ''),
    notes: String(app['notes'] ?? ''),
    compliance,
    gates: gatesFrom(app['gates'] ?? app),
    ratings: ratingsFrom(app['ratings'] ?? app),
  };
}

/**
 * A JSON file as portfolio rows.
 *
 * Accepts this page's own export, a single evaluated record, and a bare array
 * of applications, because all three exist in the wild from the previous
 * toolkit. Every record is evaluated again on the way in rather than trusting
 * the stored verdict, so an import reflects today's rules.
 */
export function importJson(text: string, catalog?: ServiceCatalog): ImportResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(text));
  } catch (error) {
    return {
      entries: [],
      findings: [{ severity: 'error', code: 'migration.json.unreadable', message: `That file is not valid JSON: ${(error as Error).message}`, source: 'portfolio' }],
    };
  }

  const container = parsed as Record<string, unknown> | unknown[];
  const list: unknown[] = Array.isArray(container)
    ? container
    : Array.isArray((container as Record<string, unknown>)['applications'])
      ? ((container as Record<string, unknown>)['applications'] as unknown[])
      : Array.isArray((container as Record<string, unknown>)['records'])
        ? ((container as Record<string, unknown>)['records'] as unknown[])
        : [container];

  const findings: Finding[] = [];
  const entries: PortfolioEntry[] = [];
  list.forEach((item, index) => {
    const app = applicationFrom(item);
    if (!app) {
      findings.push({ severity: 'warning', code: 'migration.json.skipped', message: `Record ${index + 1} has no application name, so it was skipped.`, source: 'portfolio' });
      return;
    }
    const draft = (item as Record<string, unknown> | null)?.['draft'] === true;
    const entry = entryFor(app, catalog, draft);
    const at = entries.findIndex((e) => e.id === entry.id);
    if (at < 0) entries.push(entry);
    else entries[at] = entry;
  });

  if (entries.length === 0) {
    findings.push({ severity: 'error', code: 'migration.json.nothing-read', message: 'No applications could be read from that file.', source: 'portfolio' });
  } else {
    findings.unshift({
      severity: 'info',
      code: 'migration.json.imported',
      message: `${entries.length} application${entries.length === 1 ? '' : 's'} imported and evaluated with the current rules.`,
      source: 'portfolio',
    });
  }
  return { entries, findings };
}

/** Merge imported rows into what is already held, the import winning on a clash. */
export function merge(existing: readonly PortfolioEntry[], incoming: readonly PortfolioEntry[]): PortfolioEntry[] {
  let out = [...existing];
  for (const entry of incoming) out = upsert(out, entry);
  return out;
}
