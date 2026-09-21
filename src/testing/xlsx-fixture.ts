/**
 * Build a small .xlsx in memory, for tests.
 *
 * The reader has to be tested against a real workbook's structure — zip
 * directory, relationships, shared strings, styles, deflated entries — but a
 * customer's export can never be a fixture. This writes a synthetic one with
 * the same parts, from plain arrays, so the tests say exactly what is in it.
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = (CRC_TABLE[(c ^ b) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as unknown as ArrayBuffer]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** A zip of the given files, deflated unless `stored` names them. */
export async function zip(files: Record<string, string>, stored: readonly string[] = []): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const nameBytes = encoder.encode(name);
    const raw = encoder.encode(text);
    const method = stored.includes(name) ? 0 : 8;
    const data = method === 0 ? raw : await deflate(raw);
    const crc = crc32(raw);

    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(8, method, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, raw.length, true);
    lv.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);

    const entry = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(entry.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(10, method, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, raw.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    entry.set(nameBytes, 46);

    parts.push(local, data);
    central.push(entry);
    offset += local.length + data.length;
  }
  const centralSize = central.reduce((s, c) => s + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, central.length, true);
  ev.setUint16(10, central.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);

  const out = new Uint8Array(offset + centralSize + 22);
  let at = 0;
  for (const p of [...parts, ...central, end]) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

const xml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function column(i: number): string {
  let n = i + 1;
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** A cell value: text, a number, or a date given as an Excel serial. */
export type Cell = string | number | { readonly date: number } | null;

/**
 * A workbook of the given tabs. Strings go through the shared-string table,
 * except those in the first tab's second column, which are written inline so
 * both forms are exercised. Sheet files are numbered out of tab order, as
 * Excel does after tabs are moved.
 */
export async function workbook(tabs: Record<string, Cell[][]>): Promise<Uint8Array> {
  const shared: string[] = [];
  const index = new Map<string, number>();
  const sid = (s: string): number => {
    let i = index.get(s);
    if (i === undefined) {
      i = shared.length;
      shared.push(s);
      index.set(s, i);
    }
    return i;
  };

  const names = Object.keys(tabs);
  const files: Record<string, string> = {};
  const sheetEntries: string[] = [];
  const rels: string[] = [];
  names.forEach((name, t) => {
    // Reverse the file numbering: tab 1 is the highest-numbered file.
    const fileNo = names.length - t;
    const rows = (tabs[name] ?? [])
      .map((row, r) => {
        const cells = row
          .map((value, c) => {
            const ref = `${column(c)}${r + 1}`;
            if (value === null || value === '') return '';
            if (typeof value === 'number') return `<c r="${ref}"><v>${value}</v></c>`;
            if (typeof value === 'object') return `<c r="${ref}" s="1"><v>${value.date}</v></c>`;
            if (t === 0 && c === 1) return `<c r="${ref}" t="inlineStr"><is><t>${xml(value)}</t></is></c>`;
            return `<c r="${ref}" t="s"><v>${sid(value)}</v></c>`;
          })
          .join('');
        return `<row r="${r + 1}">${cells}</row>`;
      })
      .join('');
    files[`xl/worksheets/sheet${fileNo}.xml`] =
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData><rowBreaks count="0"/></worksheet>`;
    sheetEntries.push(`<sheet name="${xml(name)}" sheetId="${t + 1}" r:id="rId${t + 1}"/>`);
    rels.push(
      `<Relationship Id="rId${t + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${fileNo}.xml"/>`,
    );
  });

  files['[Content_Types].xml'] = '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>';
  files['xl/workbook.xml'] =
    `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheetEntries.join('')}</sheets></workbook>`;
  files['xl/_rels/workbook.xml.rels'] =
    `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join('')}</Relationships>`;
  files['xl/styles.xml'] =
    '<?xml version="1.0"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy/mm/dd\\ hh:mm:ss"/></numFmts><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="164" applyNumberFormat="1"/></cellXfs></styleSheet>';
  files['xl/sharedStrings.xml'] =
    `<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${shared.length}">${shared.map((s) => `<si><t xml:space="preserve">${xml(s)}</t></si>`).join('')}</sst>`;

  return zip(files, ['xl/styles.xml']);
}
