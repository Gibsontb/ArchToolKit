/**
 * Tables from other tools' exports, read by column header and never by
 * position.
 *
 * Every provider format the Sources screen imports (Azure Migrate, Google
 * Migration Center, the AWS Migration Hub template, a Prism Central export,
 * MGN and Cloud Migration Factory sheets) is a header row plus data rows.
 * Several of those layouts are not published in full, and the tools reorder
 * columns between releases, so a parser here names each field it wants with
 * its aliases (`HeaderSpec`), and `mapHeader` finds them in whatever order
 * the file has them. A required field with no matching header is an error
 * finding naming the aliases it looked for; an unknown header is ignored.
 *
 * Headers are compared normalised: case, spaces, punctuation and a leading
 * byte-order mark do not matter ("Memory (In MB)" = "memory in mb" =
 * "MEMORY_IN_MB").
 */

import { error, warning,              } from '../../../../core/findings.js';

/** A parsed delimited file: the header cells and the data rows (blank rows dropped). */
                        
                                     
                                                
                                                          
                                    
 

/** The delimiter the header line uses most: comma, semicolon or tab. */
export function sniffDelimiter(text        )                   {
  const first = (text.replace(/^﻿/, '').split(/\r?\n/).find((l) => l.trim() !== '') ?? '');
  const count = (ch        )         => first.split(ch).length - 1;
  const c = count(','), s = count(';'), t = count('\t');
  if (t > c && t >= s) return '\t';
  if (s > c) return ';';
  return ',';
}

/** RFC 4180 CSV with a chosen delimiter; quoted fields may hold the delimiter, quotes ("") and newlines. */
export function parseDelimited(text        , delimiter         = sniffDelimiter(text))                                        {
  const src = String(text ?? '').replace(/^﻿/, '');
  const rows             = [];
  const lines           = [];
  let row           = [];
  let field = '';
  let quoted = false;
  let line = 1;
  let rowLine = 1;
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i] ;
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i += 1; } else quoted = false;
      } else {
        if (ch === '\n') line += 1;
        field += ch;
      }
      continue;
    }
    if (ch === '"' && field === '') quoted = true;
    else if (ch === delimiter) { row.push(field); field = ''; }
    else if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && src[i + 1] === '\n') i += 1;
      row.push(field);
      rows.push(row);
      lines.push(rowLine);
      row = [];
      field = '';
      line += 1;
      rowLine = line;
    } else field += ch;
  }
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row); lines.push(rowLine); }
  return { rows, lines };
}

/** The first non-blank row is the header; blank rows are dropped. */
export function readTable(text        , delimiter         )        {
  const { rows, lines } = parseDelimited(text, delimiter);
  const keep                               = [];
  rows.forEach((r, i) => { if (r.some((c) => c.trim() !== '')) keep.push({ r, l: lines[i]  }); });
  if (keep.length === 0) return { header: [], rows: [], lines: [] };
  return {
    header: keep[0] .r.map((h) => h.trim()),
    rows: keep.slice(1).map((k) => k.r),
    lines: keep.slice(1).map((k) => k.l),
  };
}

/** A header in comparable form: lower case, letters and digits only. */
export function normHeader(h        )         {
  return h.replace(/^﻿/, '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Field name to the header aliases that carry it (compared with `normHeader`). */
                                                                                  

                                              
                                                     
                                                       
                                  
                                       
                                        
                                                  
                       
 

/**
 * Finds each field's column by its aliases. The first alias that matches a
 * header wins, and one header is never claimed by two fields. Missing
 * required fields are error findings (`<code>.missing-column`).
 */
export function mapHeader                  (
  header                   , spec               , required                       , code        , fileLabel        ,
)               {
  const norm = header.map(normHeader);
  const claimed = new Set        ();
  const index                             = {};
  for (const key of Object.keys(spec)       ) {
    for (const alias of spec[key]) {
      const n = normHeader(alias);
      const at = norm.findIndex((h, i) => h === n && !claimed.has(i));
      if (at >= 0) { index[key] = at; claimed.add(at); break; }
    }
  }
  const findings            = [];
  const missing = required.filter((k) => index[k] === undefined);
  for (const k of missing) {
    findings.push(error(`${code}.missing-column`, `${fileLabel} has no "${spec[k][0]}" column (looked for: ${spec[k].join(', ')}).`, {
      remediation: 'Export the file again with its standard header row; columns are matched by name, in any order.',
    }));
  }
  return { index, unmapped: header.filter((_, i) => !claimed.has(i) && header[i] .trim() !== ''), findings, ok: missing.length === 0 };
}

/** Headers matching a pattern (e.g. "Disk 3 size (In GB)"), with the captured number, in number order. */
export function numberedColumns(header                   , pattern        )                                 {
  const out                                 = [];
  header.forEach((h, index) => {
    const m = pattern.exec(normHeader(h));
    if (m) out.push({ n: Number(m[1]), index });
  });
  return out.sort((a, b) => a.n - b.n);
}

/** A cell's trimmed text, or '' when the field was not found. */
export function cell                  (row                   , map              , key   )         {
  const i = map.index[key];
  return i === undefined ? '' : (row[i] ?? '').trim();
}

/**
 * A number from a cell: blank or unreadable is undefined. Accepts thousands
 * separators ("1,024"), a trailing unit or percent sign ("16 GB", "31%"),
 * and a decimal comma when there is no other separator ("0,5").
 */
export function num(text                    )                     {
  if (text === undefined) return undefined;
  let t = text.trim().replace(/\s*(%|[a-z]+\/?[a-z]*)$/i, '').trim();
  if (t === '') return undefined;
  if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(t)) t = t.replace(/,/g, '');
  else if (/^-?\d+,\d+$/.test(t)) t = t.replace(',', '.');
  const n = Number(t);
  return Number.isFinite(n) ? n : undefined;
}

/** Yes / no / true / false / 1 / 0; else undefined. */
export function bool(text                    )                      {
  const t = (text ?? '').trim().toLowerCase();
  if (['yes', 'y', 'true', '1', 'physical'].includes(t)) return true;
  if (['no', 'n', 'false', '0', 'virtual'].includes(t)) return false;
  return undefined;
}

/** A list cell split on semicolons, commas or whitespace, blanks dropped. */
export function list(text                    , sep         = /[;,\s]+/)           {
  return (text ?? '').split(sep).map((s) => s.trim()).filter((s) => s !== '');
}

const round1 = (n        )         => Math.round(n * 10) / 10;
export const round2 = (n        )         => Math.round(n * 100) / 100;

/** MiB / MB to GiB, one decimal. */
export const mbToGib = (mb        )         => round1(mb / 1024);
/** Bytes to GiB, one decimal. */
export const bytesToGib = (b        )         => round1(b / 2 ** 30);

/** A finding for data rows the parser skipped, with up to five line numbers. */
export function skipped(code        , what        , lines                   , why        )            {
  if (lines.length === 0) return [];
  const shown = lines.slice(0, 5).join(', ');
  const more = lines.length > 5 ? ` and ${lines.length - 5} more` : '';
  return [warning(code, `${lines.length} ${what} row${lines.length === 1 ? '' : 's'} skipped (${why}): line ${shown}${more}.`)];
}

const UNIT_GIB                                   = {
  b: 1 / 2 ** 30, bytes: 1 / 2 ** 30,
  kb: 1e3 / 2 ** 30, kib: 1 / 2 ** 20, mb: 1e6 / 2 ** 30, mib: 1 / 1024, gb: 1e9 / 2 ** 30, gib: 1, tb: 1e12 / 2 ** 30, tib: 1024,
};

/**
 * A capacity cell in GiB: "16 GiB", "500 GB", "2 TiB", "1024 MiB". A bare
 * number is taken in `bareUnit` (default GiB). Decimal units (GB) are
 * converted to binary (GiB). Undefined when unreadable.
 */
export function sizeGib(text                    , bareUnit                        = 'gib')                     {
  const m = /^\s*([0-9][0-9.,]*)\s*([a-z]*)\s*$/i.exec(text ?? '');
  if (!m) return undefined;
  const n = num(m[1]);
  if (n === undefined) return undefined;
  const unit = (m[2] ?? '').toLowerCase();
  const f = unit === '' ? UNIT_GIB[bareUnit] : UNIT_GIB[unit];
  return f === undefined ? undefined : Math.round(n * f * 10) / 10;
}
