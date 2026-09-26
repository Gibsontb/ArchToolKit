/**
 * The four planner CSVs (design section 2.3.6): workloads, databases, apps
 * and sites. The header is the grid's columns in slug form, in order
 * (`options.ts` `*_COLUMNS`), and `toCsv` then a parse gives the same rows.
 *
 * Every dropdown cell is read with `optionValue` (a value or a label, any
 * case). A cell that is neither is imported as blank, with a finding naming
 * the line, the column and what was there: never guessed. Blank means the
 * column's documented default (Env prod, criticality tier2 and so on) or, for
 * optional columns, nothing. The one exception is the OS cell, which also
 * takes free text through `classifyOs`, so a CMDB export works as it is.
 *
 * Multi-valued cells (disks, depends on, hosts, features, CIDRs) are
 * space-separated. Rows keep, in `edited`, the columns the file actually
 * filled, so a later estate reload in merge mode does not overwrite them.
 */

import { warning, error, info,              } from '../../../core/findings.js';
import { parseCsv } from '../../../migration/portfolio.js';
import { classifyOs, defaultLicenceFor, roleFromName } from '../os.js';
import {
  APP_COLUMNS, DATABASE_COLUMNS, EDITIONS_BY_ENGINE, OS_OPTIONS, RPO_BY_CRITICALITY, RTO_BY_CRITICALITY, SITE_COLUMNS,
  WAVE_PIN_OPTIONS, WORKLOAD_COLUMNS, csvHeader, itemId, optionValue, pinForWave, waveFromPin,                                  
} from '../options.js';
             
                                                                                                                     
                                                                                                                        
                     
import { appsForNames, defaultDbLicence,                                       } from './adapter.js';

                                                                   

export const CSV_COLUMNS                                                   = Object.freeze({
  workloads: WORKLOAD_COLUMNS,
  databases: DATABASE_COLUMNS,
  apps: APP_COLUMNS,
  sites: SITE_COLUMNS,
});

export const CSV_FILES                                    = Object.freeze({
  workloads: 'workloads.csv',
  databases: 'databases.csv',
  apps: 'apps.csv',
  sites: 'sites.csv',
});

/** "Download CSV templates": file name to its header line, ready for kit/archive `zip`. */
export const CSV_TEMPLATES                                   = Object.freeze(
  Object.fromEntries((Object.keys(CSV_FILES)             ).map((k) => [CSV_FILES[k], `${csvHeader(CSV_COLUMNS[k])}\n`])),
);

                              
                     
                               
 

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

function csvCell(value        )         {
  return /[",\n\r]/.test(value) || /^\s|\s$/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function formatCell(col            , value         )         {
  if (value === undefined || value === null) return '';
  if (Array.isArray(value)) return value.map(String).join(' ');
  if (col.key === 'wave' && typeof value === 'number') return pinForWave(value) ?? '';
  return String(value);
}

/** Rows as CSV text: the header, then one line per row, each ending in a newline. */
                                                                            
                                                                            
                                                                  
                                                                    
                                                                      
export function toCsv(kind         , rows                   )         {
  const columns = CSV_COLUMNS[kind];
  const lines = [csvHeader(columns)];
  for (const row of rows) {
    const r = row                           ;
    lines.push(columns.map((c) => csvCell(formatCell(c, r[c.key]))).join(','));
  }
  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

const norm = (s        )         => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '');

/** A table row: the cells by column key, plus where it came from. */
                    
                        
                         
                                              
 

function readTable(kind         , text        , findings           )                         {
  const columns = CSV_COLUMNS[kind];
  const file = CSV_FILES[kind];
  const rows = parseCsv(text);
  const header = rows[0];
  if (!header) {
    findings.push(info('plan.csv.empty', `${file} has no rows.`));
    return [];
  }
  const byName = new Map                    ();
  for (const c of columns) for (const n of [c.slug, c.label, c.key]) if (!byName.has(norm(n))) byName.set(norm(n), c);
  const map                             = [];
  const taken = new Set        ();
  const unknown           = [];
  for (const h of header) {
    const c = byName.get(norm(h));
    if (!c || taken.has(c.key)) {
      if (h.trim()) unknown.push(h.trim());
      map.push(undefined);
      continue;
    }
    taken.add(c.key);
    map.push(c);
  }
  const first = columns[0];
  if (!first || !taken.has(first.key)) {
    findings.push(error('plan.csv.no-name-column', `${file} has no “${first?.slug ?? 'name'}” column, so no rows were read.`, {
      remediation: `The header should be: ${csvHeader(columns)}`,
    }));
    return undefined;
  }
  if (unknown.length > 0) {
    findings.push(warning('plan.csv.unknown-column', `${file}: column(s) not recognised and ignored: ${unknown.join(', ')}.`, {
      remediation: `The header should be: ${csvHeader(columns)}`,
    }));
  }
  const out             = [];
  rows.slice(1).forEach((row, i) => {
    const cells = new Map                ();
    map.forEach((c, j) => {
      if (c) cells.set(c.key, (row[j] ?? '').trim());
    });
    out.push({ line: i + 2, index: i, cells });
  });
  return out;
}

/** Cell readers for one row, each recording what it could not read. */
class Cells {
  /** Columns the file filled with something readable. */
           filled           = [];
                   kind         ;
                   rec          ;
                   findings           ;
                   rowIndex        ;

  constructor(kind         , rec          , rowIndex        , findings           ) {
    this.kind = kind;
    this.rec = rec;
    this.rowIndex = rowIndex;
    this.findings = findings;
  }

  raw(key        )         {
    return this.rec.cells.get(key) ?? '';
  }

          col(key        )             {
    const c = CSV_COLUMNS[this.kind].find((x) => x.key === key);
    if (!c) throw new Error(`No column ${key} in ${this.kind}`);
    return c;
  }

          bad(key        , value        , why        )       {
    const c = this.col(key);
    this.findings.push(warning('plan.csv.unknown-value', `${CSV_FILES[this.kind]} line ${this.rec.line}, ${c.slug}: “${value}” ${why}, so the cell was left blank.`, {
      path: `${this.kind}[${this.rowIndex}].${key}`,
      remediation: c.options ? `Use one of: ${c.options.map((o) => o.value).join(', ')}.` : 'Correct the cell and import again, or edit it on the grid.',
    }));
  }

  text(key        )                     {
    const v = this.raw(key);
    if (!v) return undefined;
    this.filled.push(key);
    return v;
  }

  select                  (key        , options                          )                {
    const v = this.raw(key);
    if (!v) return undefined;
    const found = optionValue(options, v);
    if (found === undefined) {
      this.bad(key, v, 'is not an option');
      return undefined;
    }
    this.filled.push(key);
    return found;
  }

  /** The column's own option table. */
  choice                  (key        )                {
    return this.select(key, (this.col(key).options ?? [])                            );
  }

  number(key        , integer = false)                     {
    const v = this.raw(key);
    if (!v) return undefined;
    const n = Number(v.replace(/_/g, ''));
    if (!Number.isFinite(n) || n < 0 || (integer && !Number.isInteger(n))) {
      this.bad(key, v, integer ? 'is not a whole number' : 'is not a number');
      return undefined;
    }
    this.filled.push(key);
    return n;
  }

  list(key        , split         = /\s+/)                       {
    const v = this.raw(key);
    if (!v) return undefined;
    this.filled.push(key);
    return v.split(split).map((t) => t.trim()).filter(Boolean);
  }

  numbers(key        )                       {
    const v = this.raw(key);
    if (!v) return undefined;
    const out           = [];
    for (const t of v.split(/[\s;+]+/).filter(Boolean)) {
      const n = Number(t.replace(/gi?b$/i, ''));
      if (Number.isFinite(n) && n > 0) out.push(n);
      else this.bad(key, t, 'is not a disk size in GiB');
    }
    if (out.length > 0) this.filled.push(key);
    return out.length > 0 ? out : undefined;
  }

  multi                  (key        )                  {
    const v = this.raw(key);
    if (!v) return undefined;
    const options = (this.col(key).options ?? [])                            ;
    const out      = [];
    for (const t of v.split(/[\s,;]+/).filter(Boolean)) {
      const found = optionValue(options, t);
      if (found === undefined) this.bad(key, t, 'is not an option');
      else if (!out.includes(found)) out.push(found);
    }
    if (out.length > 0) this.filled.push(key);
    return out.length > 0 ? out : undefined;
  }

  /** The OS: an id or label, else free text through the classifier. */
  os(key        )                   {
    const v = this.raw(key);
    if (!v) return undefined;
    const found = optionValue(OS_OPTIONS, v) ?? classifyOs(v);
    if (found === 'unknown' && v.toLowerCase() !== 'unknown') {
      this.bad(key, v, 'is not an operating system the planner recognises');
      return undefined;
    }
    this.filled.push(key);
    return found;
  }

  wave(key        )                     {
    const v = this.raw(key);
    if (!v) return undefined;
    const pin = optionValue(WAVE_PIN_OPTIONS, v);
    const n = waveFromPin(pin ?? v);
    if (n === undefined) {
      this.bad(key, v, 'is not a wave from 0 to 9');
      return undefined;
    }
    this.filled.push(key);
    return n;
  }
}

/**
 * Rows read by `build`, with empty names and repeated names reported (the
 * first of a repeated name is kept).
 */
function readRows   (
  kind         ,
  text        ,
  build                                   ,
)              {
  const findings            = [];
  const records = readTable(kind, text, findings);
  if (!records) return { rows: [], findings };
  const nameKey = CSV_COLUMNS[kind][0]?.key ?? 'name';
  const rows      = [];
  const seen = new Set        ();
  const repeated           = [];
  let skipped = 0;
  for (const rec of records) {
    const name = (rec.cells.get(nameKey) ?? '').trim();
    if (!name) {
      skipped += 1;
      continue;
    }
    const id = name.toLowerCase();
    if (seen.has(id)) {
      repeated.push(`${name} (line ${rec.line})`);
      continue;
    }
    seen.add(id);
    rows.push(build(new Cells(kind, rec, rows.length, findings), name));
  }
  if (skipped > 0) {
    findings.push(warning('plan.csv.name-missing', `${CSV_FILES[kind]}: ${skipped} row(s) with no ${CSV_COLUMNS[kind][0]?.slug ?? 'name'} were skipped.`));
  }
  if (repeated.length > 0) {
    findings.push(warning('plan.csv.duplicate-name', `${CSV_FILES[kind]}: repeated name(s), the first row of each was kept: ${repeated.slice(0, 5).join(', ')}${repeated.length > 5 ? ' …' : ''}.`));
  }
  return { rows, findings };
}

function withEdited                  (row   , filled                   , nameKey = 'name')    {
  const edited = [...new Set(filled.filter((k) => k !== nameKey))];
  return edited.length > 0 ? { ...row, edited } : row;
}

/** `workloads.csv` as rows. */
export function parseWorkloadsCsv(text        )                     {
  return readRows('workloads', text, (c, name) => {
    const os = c.os('os') ?? 'unknown';
    const criticality = c.choice             ('criticality') ?? 'tier2';
    const residency = c.choice           ('residency');
    const disposition = c.choice             ('disposition');
    const pin = c.choice          ('pin');
    const row           = {
      id: itemId('workload', name),
      name,
      app: c.text('app') ?? '',
      env: c.choice     ('env') ?? 'prod',
      role: c.choice      ('role') ?? roleFromName(name),
      os,
      vcpu: c.number('vcpu') ?? 0,
      ramGib: c.number('ramGib') ?? 0,
      disksGib: c.numbers('disksGib') ?? [],
      criticality,
      rpo: c.choice     ('rpo') ?? RPO_BY_CRITICALITY[criticality],
      rto: c.choice     ('rto') ?? RTO_BY_CRITICALITY[criticality],
      licence: c.choice           ('licence') ?? defaultLicenceFor(os),
      ...(residency ? { residency } : {}),
      ...(disposition ? { disposition } : {}),
      dependsOn: c.list('dependsOn') ?? [],
      ...(pin ? { pin } : {}),
      source: 'csv',
    };
    return withEdited(row, c.filled);
  });
}

/** The edition a database row starts with when the file does not say. */
function defaultEdition(engine          )            {
  return EDITIONS_BY_ENGINE[engine].includes('community') ? 'community' : 'commercial';
}

/**
 * `databases.csv` as rows. vCPU and RAM default to the first host's, when the
 * workloads are given, so a host and its database stay consistent.
 */
export function parseDatabasesCsv(text        , workloads                      = [])                     {
  const byName = new Map(workloads.map((w) => [w.name.toLowerCase(), w]));
  return readRows('databases', text, (c, name) => {
    const engine = c.choice          ('engine') ?? 'other';
    const edition = c.choice           ('edition') ?? defaultEdition(engine);
    const hosts = c.list('hosts') ?? [];
    const host = hosts[0] ? byName.get(hosts[0].toLowerCase()) : undefined;
    const pinService = c.choice             ('pinService');
    const row           = {
      id: itemId('database', name),
      name,
      engine,
      edition,
      version: c.choice             ('version') ?? 'other',
      hosts,
      vcpu: c.number('vcpu') ?? host?.vcpu ?? 0,
      ramGib: c.number('ramGib') ?? host?.ramGib ?? 0,
      sizeGib: c.number('sizeGib') ?? 0,
      ha: c.choice      ('ha') ?? 'none',
      dr: c.choice      ('dr') ?? 'none',
      features: c.multi           ('features') ?? [],
      licence: c.choice           ('licence') ?? defaultDbLicence({ engine, edition }),
      app: c.text('app') ?? '',
      ...(pinService ? { pinService } : {}),
      source: 'csv',
    };
    return withEdited(row, c.filled);
  });
}

/** `apps.csv` as rows. */
export function parseAppsCsv(text        )                {
  return readRows('apps', text, (c, name) => {
    const owner = c.text('owner');
    const deadlineMonths = c.number('deadlineMonths');
    const route = c.choice             ('route');
    const wave = c.wave('wave');
    const notes = c.text('notes');
    const row      = {
      id: itemId('app', name),
      name,
      ...(owner ? { owner } : {}),
      criticality: c.choice             ('criticality') ?? 'tier2',
      residency: c.choice           ('residency') ?? 'any',
      latencyToOnPrem: c.choice         ('latencyToOnPrem') ?? 'tolerant',
      ...(deadlineMonths !== undefined ? { deadlineMonths } : {}),
      special: c.choice         ('special') ?? 'none',
      ...(route ? { route } : {}),
      ...(wave !== undefined ? { wave } : {}),
      ...(notes ? { notes } : {}),
      source: 'csv',
    };
    return withEdited(row, c.filled);
  });
}

/** `sites.csv` as rows (for Screen 5's sites grid). */
export function parseSitesCsv(text        )                 {
  return readRows('sites', text, (c, name) => {
    const vpnPeer = c.text('vpnPeer');
    const bgpAsn = c.number('bgpAsn', true);
    const circuitLocation = c.text('circuitLocation');
    return {
      name,
      ...(vpnPeer ? { vpnPeer } : {}),
      ...(bgpAsn !== undefined ? { bgpAsn } : {}),
      cidrs: c.list('cidrs', /[\s,;]+/) ?? [],
      bandwidth: c.choice           ('bandwidth') ?? '1g',
      circuit: c.choice         ('circuit') ?? 'none',
      ...(circuitLocation ? { circuitLocation } : {}),
    };
  });
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

                           
                                                    
                        
                                                                           
                                           
 

/** One CSV file as an intake result. Workload and database files also propose app rows for their app names. */
export function intakeFromCsv(input          )               {
  if (input.kind === 'workloads') {
    const { rows, findings } = parseWorkloadsCsv(input.text);
    return { workloads: rows, databases: [], apps: appsForNames(rows.map((r) => r.app), 'csv'), findings };
  }
  if (input.kind === 'databases') {
    const { rows, findings } = parseDatabasesCsv(input.text, input.workloads);
    return { workloads: [], databases: rows, apps: appsForNames(rows.map((r) => r.app), 'csv'), findings };
  }
  const { rows, findings } = parseAppsCsv(input.text);
  return { workloads: [], databases: [], apps: rows, findings };
}

export const CSV_ADAPTER                          = {
  id: 'csv',
  label: 'CSV file (workloads, databases or apps)',
  itemSource: 'csv',
  parse: (input          ) => intakeFromCsv(input),
};
