/**
 * Writing an .xlsx workbook with nothing but the platform.
 *
 * The toolkit reads workbooks (`core/xlsx.ts`) but, until this file, could not
 * write one. Reports and grids want a real spreadsheet — one tab per grid, the
 * header styled and frozen — and a CSV cannot hold several tabs.
 *
 * This is deliberately minimal SpreadsheetML: a workbook, one worksheet per
 * sheet, a styles part with a bold header style and a wrapped style, and
 * either inline strings (the default: each cell carries its own text) or a
 * shared-strings table. No formulas are ever written — a cell whose text
 * starts with `=` is stored as text, so a grid value can never run as one.
 *
 * Reproducible: the parts are written in a fixed order with fixed content, and
 * the zip entries carry the date passed in (the plan's `savedAt`), so the same
 * input gives the same bytes. Nothing about the user or the machine is written
 * — there is no docProps/core.xml with a creator or a modified time.
 *
 * Stored entries go through `kit/archive.ts` `zip`. Deflated entries are written
 * here with the same CRC, and deflated by the platform's CompressionStream.
 */

import { crc32, zip } from './archive.js';

                                                                         

                            
                                                                                          
                        
                                                            
                                                       
                                                                     
                            
                                                                                  
                                      
                                                    
                          
 

                                   
                                                                                        
                                         
                                         
                                              
     
                                                                              
                                                                              
     
                                
 

export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const ZIP_EPOCH = '1980-01-01T00:00:00Z';

// ---------------------------------------------------------------------------
// Names and references
// ---------------------------------------------------------------------------

/** 0 → "A", 25 → "Z", 26 → "AA". */
export function columnLetter(index        )         {
  let n = index + 1;
  let out = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    out = String.fromCharCode(65 + r) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/** Excel's tab-name rules: 1–31 characters, none of `[]:*?/\`, not starting or ending with an apostrophe. */
export function cleanSheetName(name        )         {
  const cleaned = String(name ?? '')
    .replace(/[[\]:*?/\\]/g, ' ')
    .replace(/[\u0000-\u001f]/g, '')
    .replace(/^'+|'+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 31)
    .trim();
  return cleaned || 'Sheet';
}

/** Clean every name and make them unique (case-insensitively, as Excel compares them). */
export function uniqueSheetNames(names                   )           {
  const used = new Set        ();
  return names.map((raw) => {
    const base = cleanSheetName(raw);
    let name = base;
    for (let n = 2; used.has(name.toLowerCase()); n += 1) {
      const suffix = ` (${n})`;
      name = `${base.slice(0, 31 - suffix.length).trim()}${suffix}`;
    }
    used.add(name.toLowerCase());
    return name;
  });
}

// ---------------------------------------------------------------------------
// XML text
// ---------------------------------------------------------------------------

/**
 * Text as cell content. XML 1.0 cannot carry most control characters, so they
 * are written the way Excel writes them, `_xHHHH_`; a literal `_xHHHH_` in the
 * text has its underscore escaped as `_x005F_` so it reads back unchanged.
 */
export function xmlText(text        )         {
  return text
    .replace(/_(x[0-9A-Fa-f]{4}_)/g, '_x005F_$1')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, (c) => `_x${c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}_`);
}
const xmlAttr = (text        )         => xmlText(text).replace(/"/g, '&quot;');

const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const NS_MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const NS_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const NS_PKG_REL = 'http://schemas.openxmlformats.org/package/2006/relationships';

/** Style indexes in styles.xml cellXfs. */
const STYLE = { normal: 0, header: 1, wrap: 2 }         ;

function stylesXml()         {
  return `${XML_DECL}<styleSheet xmlns="${NS_MAIN}">`
    + '<fonts count="2"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font>'
    + '<font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font></fonts>'
    + '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>'
    + '<fill><patternFill patternType="solid"><fgColor rgb="FFD9E1F2"/><bgColor indexed="64"/></patternFill></fill></fills>'
    + '<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border>'
    + '<border><left/><right/><top/><bottom style="thin"><color auto="1"/></bottom><diagonal/></border></borders>'
    + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
    + '<cellXfs count="3">'
    + '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
    + '<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/>'
    + '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>'
    + '</cellXfs>'
    + '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>'
    + '</styleSheet>';
}

class SharedStrings {
           list           = [];
                   index = new Map                ();
          refs = 0;
  add(text        )         {
    this.refs += 1;
    const known = this.index.get(text);
    if (known !== undefined) return known;
    const i = this.list.length;
    this.list.push(text);
    this.index.set(text, i);
    return i;
  }
  xml()         {
    const items = this.list.map((s) => `<si><t xml:space="preserve">${xmlText(s)}</t></si>`).join('');
    return `${XML_DECL}<sst xmlns="${NS_MAIN}" count="${this.refs}" uniqueCount="${this.list.length}">${items}</sst>`;
  }
}

function cellXml(ref        , value               , style        , shared                      )         {
  if (value === null || value === undefined || value === '') return '';
  const s = style ? ` s="${style}"` : '';
  if (typeof value === 'boolean') return `<c r="${ref}"${s} t="b"><v>${value ? 1 : 0}</v></c>`;
  if (typeof value === 'number' && Number.isFinite(value)) return `<c r="${ref}"${s}><v>${value}</v></c>`;
  const text = String(value);
  if (shared) return `<c r="${ref}"${s} t="s"><v>${shared.add(text)}</v></c>`;
  return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${xmlText(text)}</t></is></c>`;
}

function widthsOf(sheet           , columns        )           {
  const out           = [];
  for (let c = 0; c < columns; c += 1) {
    const given = sheet.widths?.[c];
    if (given !== undefined && Number.isFinite(given) && given > 0) {
      out.push(Math.min(255, given));
      continue;
    }
    let longest = 0;
    for (const row of sheet.rows) {
      const v = row[c];
      if (v === null || v === undefined) continue;
      for (const line of String(v).split('\n')) longest = Math.max(longest, line.length);
    }
    out.push(Math.max(8, Math.min(60, longest + 2)));
  }
  return out;
}

function sheetXml(sheet           , first         , shared                      )         {
  const header = sheet.header !== false && sheet.rows.length > 0;
  const columns = sheet.rows.reduce((m, r) => Math.max(m, r.length), 0);
  const rowsXml           = [];
  sheet.rows.forEach((row, r) => {
    const style = header && r === 0 ? STYLE.header : sheet.wrap ? STYLE.wrap : STYLE.normal;
    const cells = row.map((v, c) => cellXml(`${columnLetter(c)}${r + 1}`, v, style, shared)).join('');
    if (cells) rowsXml.push(`<row r="${r + 1}">${cells}</row>`);
  });
  const dimension = columns > 0 && sheet.rows.length > 0 ? `A1:${columnLetter(columns - 1)}${sheet.rows.length}` : 'A1';
  const selected = first ? ' tabSelected="1"' : '';
  const view = header
    ? `<sheetView${selected} workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A2" sqref="A2"/></sheetView>`
    : `<sheetView${selected} workbookViewId="0"/>`;
  const cols = columns > 0
    ? `<cols>${widthsOf(sheet, columns).map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>`
    : '';
  return `${XML_DECL}<worksheet xmlns="${NS_MAIN}" xmlns:r="${NS_REL}">`
    + `<dimension ref="${dimension}"/><sheetViews>${view}</sheetViews><sheetFormatPr defaultRowHeight="15"/>`
    + `${cols}<sheetData>${rowsXml.join('')}</sheetData>`
    + '<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/></worksheet>';
}

/**
 * The workbook's parts, path → XML, in the order they are zipped. Exposed for
 * tests and for a caller that wants to add the parts to a larger archive.
 */
export function xlsxParts(sheets                      , options                                    = {})                         {
  const list = sheets.length > 0 ? sheets : [{ name: 'Sheet1', rows: [] }];
  const names = uniqueSheetNames(list.map((s) => s.name));
  const shared = options.strings === 'shared' ? new SharedStrings() : null;
  const sheetParts = list.map((s, i) => sheetXml(s, i === 0, shared));

  const contentTypes = `${XML_DECL}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
    + list.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')
    + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
    + (shared ? '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>' : '')
    + '</Types>';
  const rootRels = `${XML_DECL}<Relationships xmlns="${NS_PKG_REL}">`
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
    + '</Relationships>';
  const workbook = `${XML_DECL}<workbook xmlns="${NS_MAIN}" xmlns:r="${NS_REL}">`
    + '<bookViews><workbookView activeTab="0"/></bookViews><sheets>'
    + names.map((n, i) => `<sheet name="${xmlAttr(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')
    + '</sheets></workbook>';
  const n = list.length;
  const workbookRels = `${XML_DECL}<Relationships xmlns="${NS_PKG_REL}">`
    + list.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')
    + `<Relationship Id="rId${n + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`
    + (shared ? `<Relationship Id="rId${n + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>` : '')
    + '</Relationships>';

  const parts                         = {
    '[Content_Types].xml': contentTypes,
    '_rels/.rels': rootRels,
    'xl/workbook.xml': workbook,
    'xl/_rels/workbook.xml.rels': workbookRels,
    'xl/styles.xml': stylesXml(),
  };
  sheetParts.forEach((xml, i) => {
    parts[`xl/worksheets/sheet${i + 1}.xml`] = xml;
  });
  if (shared) parts['xl/sharedStrings.xml'] = shared.xml();
  return parts;
}

// ---------------------------------------------------------------------------
// The zip
// ---------------------------------------------------------------------------

/**
 * archive.ts stamps entries with the local wall-clock fields of the Date it is
 * given. Handing it a Date whose local fields are the UTC fields of `when`
 * makes the stamp the same in every time zone.
 */
function zoneFreeDate(when                           )       {
  const d = when instanceof Date ? when : new Date(when ?? ZIP_EPOCH);
  const t = Number.isNaN(d.getTime()) ? new Date(ZIP_EPOCH) : d;
  return new Date(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate(), t.getUTCHours(), t.getUTCMinutes(), t.getUTCSeconds());
}

async function deflateRaw(data            )                      {
  const stream = new Blob([data                           ]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** A deflated zip, entries in the given order, UTF-8 names. */
async function deflatedZip(files                                  , when      )                      {
  const encoder = new TextEncoder();
  const time = (when.getHours() << 11) | (when.getMinutes() << 5) | Math.floor(when.getSeconds() / 2);
  const date = ((Math.max(1980, when.getFullYear()) - 1980) << 9) | ((when.getMonth() + 1) << 5) | when.getDate();
  const parts               = [];
  const centrals               = [];
  let offset = 0;
  const entries = Object.entries(files);
  for (const [path, text] of entries) {
    const name = encoder.encode(path);
    const raw = encoder.encode(text);
    const data = await deflateRaw(raw);
    const crc = crc32(raw);
    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x0800, true);
    lv.setUint16(8, 8, true);
    lv.setUint16(10, time, true);
    lv.setUint16(12, date, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, raw.length, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    parts.push(local, data);

    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 8, true);
    cv.setUint16(12, time, true);
    cv.setUint16(14, date, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, raw.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    central.set(name, 46);
    centrals.push(central);
    offset += local.length + data.length;
  }
  const centralSize = centrals.reduce((s, c) => s + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  const all = [...parts, ...centrals, end];
  const out = new Uint8Array(all.reduce((s, p) => s + p.length, 0));
  let at = 0;
  for (const p of all) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** The workbook as .xlsx bytes. */
export async function writeXlsx(sheets                      , options                   = {})                      {
  const parts = xlsxParts(sheets, options);
  const when = zoneFreeDate(options.when);
  if (options.compression === 'deflate') return deflatedZip(parts, when);
  return zip(parts, when);
}

/** A grid (header + rows of records) as a sheet: the columns in the given order. */
export function sheetFromRecords(
  name        ,
  columns                   ,
  records                                                    ,
  headers                    = columns,
)            {
  return { name, rows: [headers, ...records.map((r) => columns.map((c) => r[c]))] };
}
