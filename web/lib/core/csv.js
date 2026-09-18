/**
 * RFC 4180 CSV parsing.
 *
 * Inventory exports routinely contain quoted fields with embedded commas
 * (VM annotations), embedded newlines (notes fields), and escaped quotes, so a
 * `split(',')` would silently corrupt the data. This is a real state-machine
 * parser.
 *
 * It also handles the deviations real tools produce: a UTF-8 BOM from Excel,
 * CRLF line endings, semicolon delimiters from European locales, and trailing
 * blank lines.
 */

                                  
                                                                     
                              
                                                      
                             
                                                            
                                   
 

                           
                             
                            
                             
 

const BOM = '﻿';

/**
 * Guess the delimiter by counting candidates outside quoted regions in the
 * first line. Excel on a European locale emits semicolons, and some PowerShell
 * exports use tabs.
 */
export function detectDelimiter(text        )         {
  const firstLine = text.slice(0, 8192).split(/\r?\n/)[0] ?? '';
  const candidates = [',', ';', '\t', '|'];

  let best = ',';
  let bestCount = 0;
  for (const candidate of candidates) {
    let count = 0;
    let inQuotes = false;
    for (let i = 0; i < firstLine.length; i += 1) {
      const char = firstLine[i];
      if (char === '"') inQuotes = !inQuotes;
      else if (char === candidate && !inQuotes) count += 1;
    }
    if (count > bestCount) {
      bestCount = count;
      best = candidate;
    }
  }
  return best;
}

export function parseCsv(input        , options                  = {})           {
  let text = input;
  if (text.startsWith(BOM)) text = text.slice(BOM.length);

  const delimiter = options.delimiter ?? detectDelimiter(text);
  const skipEmpty = options.skipEmptyRows ?? true;

  const rows             = [];
  let row           = [];
  let field = '';
  let inQuotes = false;
  let i = 0;

  const endField = ()       => {
    row.push(field);
    field = '';
  };

  const endRow = ()       => {
    endField();
    if (!skipEmpty || row.some((value) => value.length > 0)) rows.push(row);
    row = [];
  };

  while (i < text.length) {
    const char = text[i]          ;

    if (inQuotes) {
      if (char === '"') {
        // A doubled quote inside a quoted field is a literal quote.
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += char;
      i += 1;
      continue;
    }

    if (char === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }

    if (char === delimiter) {
      endField();
      i += 1;
      continue;
    }

    if (char === '\r') {
      // CRLF or a lone CR both terminate the row.
      if (text[i + 1] === '\n') i += 1;
      endRow();
      i += 1;
      continue;
    }

    if (char === '\n') {
      endRow();
      i += 1;
      continue;
    }

    field += char;
    i += 1;
  }

  // Flush whatever is left; a file without a trailing newline still has a row.
  if (field.length > 0 || row.length > 0) endRow();

  if (options.headers === false) {
    return { headers: [], rows, delimiter };
  }

  const headers = (rows.shift() ?? []).map((h) => h.trim());
  return { headers, rows, delimiter };
}

/** Convert a table to objects keyed by header. Later duplicate headers win. */
export function toRecords(table          )                           {
  return table.rows.map((row) => {
    const record                         = {};
    table.headers.forEach((header, index) => {
      record[header] = row[index] ?? '';
    });
    return record;
  });
}

export function parseCsvRecords(input        , options                  )                           {
  return toRecords(parseCsv(input, options));
}

// ---------------------------------------------------------------------------
// Field coercion
// ---------------------------------------------------------------------------

/**
 * Parse a number from an export field.
 *
 * Handles thousands separators, a trailing percent sign, parenthesised
 * negatives, and the various empty markers tools emit. Returns null rather than
 * NaN so callers must decide what an absent value means.
 */
export function parseNumber(value                           )                {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  if (trimmed === '' || trimmed === '-' || /^n\/?a$/i.test(trimmed) || /^null$/i.test(trimmed)) {
    return null;
  }

  let cleaned = trimmed.replace(/%$/, '');
  let negative = false;
  if (/^\(.*\)$/.test(cleaned)) {
    negative = true;
    cleaned = cleaned.slice(1, -1);
  }

  // Work out which separator is the decimal mark and which is thousands.
  //
  // Counting matters: "1,048,576" has two commas, so they must be thousands
  // separators, whereas "1.234,56" has one of each and the comma comes last,
  // making it the European decimal mark. Comparing positions alone gets the
  // first case wrong.
  const commaCount = (cleaned.match(/,/g) ?? []).length;
  const dotCount = (cleaned.match(/\./g) ?? []).length;

  if (commaCount > 1) {
    // Multiple commas can only be thousands separators.
    cleaned = cleaned.replace(/,/g, '');
  } else if (dotCount > 1) {
    // Multiple dots can only be thousands separators, so a comma is decimal.
    cleaned = cleaned.replace(/\./g, '').replace(/,/g, '.');
  } else if (commaCount === 1 && dotCount === 1) {
    // One of each: whichever appears last is the decimal mark.
    cleaned =
      cleaned.lastIndexOf(',') > cleaned.lastIndexOf('.')
        ? cleaned.replace(/\./g, '').replace(/,/g, '.')
        : cleaned.replace(/,/g, '');
  } else if (commaCount === 1) {
    // Ambiguous: "3,5" is a European decimal, "1,048" is US thousands.
    // Exactly three digits after the comma indicates a thousands group.
    const after = cleaned.slice(cleaned.indexOf(',') + 1);
    cleaned = /^\d{3}$/.test(after) ? cleaned.replace(/,/g, '') : cleaned.replace(/,/g, '.');
  }

  cleaned = cleaned.replace(/\s/g, '');

  const parsed = Number(cleaned);
  if (!Number.isFinite(parsed)) return null;
  return negative ? -parsed : parsed;
}

export function parseBoolean(value                           )                 {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim().toLowerCase();
  if (trimmed === '') return null;
  if (['true', 'yes', 'y', '1', 'enabled', 'on'].includes(trimmed)) return true;
  if (['false', 'no', 'n', '0', 'disabled', 'off'].includes(trimmed)) return false;
  return null;
}

/**
 * Look up a value by any of several candidate header names.
 *
 * Export tools rename columns between versions — "# Memory" became "Memory" in
 * some RVTools releases — so importers list every spelling they know and this
 * takes the first that is present. Matching ignores case, whitespace and
 * punctuation so "# vCPUs", "#vCPUs" and "vCPUs" all resolve.
 */
export function pick(
  record                        ,
  ...candidates          
)                     {
  for (const candidate of candidates) {
    const direct = record[candidate];
    if (direct !== undefined && direct !== '') return direct;
  }

  const normalize = (s        )         => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const normalized = new Map                ();
  for (const [key, value] of Object.entries(record)) {
    const nk = normalize(key);
    if (!normalized.has(nk) || value !== '') normalized.set(nk, value);
  }

  for (const candidate of candidates) {
    const value = normalized.get(normalize(candidate));
    if (value !== undefined && value !== '') return value;
  }
  return undefined;
}

export function pickNumber(record                        , ...candidates          )                {
  return parseNumber(pick(record, ...candidates));
}

/** Serialize records back to CSV, quoting only where required. */
export function toCsv(records                                    , headers           )         {
  if (records.length === 0) return '';
  const cols = headers ?? [...new Set(records.flatMap((r) => Object.keys(r)))];

  const escape = (value         )         => {
    const text = value === null || value === undefined ? '' : String(value);
    return /["\n\r,;\t]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };

  const lines = [cols.join(',')];
  for (const record of records) {
    lines.push(cols.map((col) => escape(record[col])).join(','));
  }
  return `${lines.join('\n')}\n`;
}
