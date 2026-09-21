/**
 * Reading an .xlsx workbook with nothing but the platform.
 *
 * RVTools writes one workbook with every tab in it, and asking someone to save
 * twenty-seven tabs out as CSV one at a time is how half of them go missing. So
 * the workbook is read as it is. The toolkit has no dependencies and runs
 * air-gapped, so there is no SheetJS to reach for; an .xlsx is a zip of XML,
 * and both halves of that are within reach:
 *
 *  - the zip's central directory says where each entry is and how it is stored,
 *    and `DecompressionStream('deflate-raw')` — in every current browser and in
 *    Node 18+ — inflates it;
 *  - the sheets are regular enough XML that a streaming scan over `<row>`
 *    elements is both correct and fast.
 *
 * Streaming is not optional. A real estate's vDisk tab is 150 MB of XML and
 * vPartition not far behind; building a DOM of that, or even holding it as one
 * string, falls over in a browser tab. Rows are handed to a callback as they
 * are inflated, and only the shared-string table is held whole, because every
 * sheet refers into it.
 *
 * Cell values come back as the strings a person would see: shared and inline
 * strings resolved, entities decoded, booleans as True/False, and a number in a
 * date-formatted cell as an ISO date-time — RVTools stores its dates as Excel
 * serials, and `46063.09` means nothing to anyone.
 */

export interface XlsxWorkbook {
  /** Tab names, in workbook order. */
  readonly sheets: readonly string[];
  /**
   * Stream one tab's rows, the header row included, as arrays of cell text.
   * Gaps between cells come back as empty strings. Return `false` from the
   * callback to stop early. Resolves with the number of rows delivered.
   */
  rows(sheet: string, onRow: (cells: string[], index: number) => boolean | void): Promise<number>;
}

interface ZipEntry {
  readonly name: string;
  readonly method: number;
  readonly compressedSize: number;
  readonly localHeaderOffset: number;
}

export class XlsxError extends Error {}

// ---------------------------------------------------------------------------
// Zip
// ---------------------------------------------------------------------------

function readZipDirectory(bytes: Uint8Array): Map<string, ZipEntry> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // The end-of-central-directory record sits in the last 22 bytes plus up to
  // 64 KiB of comment, so it is found by scanning backwards for its signature.
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i -= 1) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new XlsxError('Not an .xlsx file: no zip directory was found.');

  const count = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  const decoder = new TextDecoder();
  const entries = new Map<string, ZipEntry>();

  for (let i = 0; i < count; i += 1) {
    if (view.getUint32(offset, true) !== 0x02014b50) {
      throw new XlsxError('The workbook’s zip directory is damaged.');
    }
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localHeaderOffset = view.getUint32(offset + 42, true);
    const name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    entries.set(name, { name, method, compressedSize, localHeaderOffset });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** The entry's contents as a stream of decoded text. */
function entryText(bytes: Uint8Array, entry: ZipEntry): ReadableStream<string> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const at = entry.localHeaderOffset;
  if (view.getUint32(at, true) !== 0x04034b50) {
    throw new XlsxError(`The workbook entry ${entry.name} is damaged.`);
  }
  // The local header repeats the name and carries its own extra field, whose
  // length can differ from the central directory's copy.
  const start = at + 30 + view.getUint16(at + 26, true) + view.getUint16(at + 28, true);
  const data = bytes.subarray(start, start + entry.compressedSize);

  // Handed over in slices so the inflater is never given one enormous chunk.
  const SLICE = 1 << 20;
  let position = 0;
  const raw = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (position >= data.length) {
        controller.close();
        return;
      }
      controller.enqueue(data.slice(position, position + SLICE));
      position += SLICE;
    },
  });

  let stream: ReadableStream<Uint8Array>;
  if (entry.method === 0) stream = raw;
  else if (entry.method === 8) {
    stream = raw.pipeThrough(new DecompressionStream('deflate-raw') as unknown as TransformStream<Uint8Array, Uint8Array>);
  } else throw new XlsxError(`The workbook entry ${entry.name} uses an unsupported compression method.`);

  return stream.pipeThrough(new TextDecoderStream() as unknown as TransformStream<Uint8Array, string>);
}

async function entryString(bytes: Uint8Array, entry: ZipEntry): Promise<string> {
  let text = '';
  const reader = entryText(bytes, entry).getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return text;
    text += value;
  }
}

/**
 * Call `onElement` for every complete `<tag …>…</tag>` (or self-closed tag) in
 * the stream, without ever holding more than one chunk and a partial element.
 */
async function eachElement(
  stream: ReadableStream<string>,
  tag: string,
  onElement: (xml: string) => boolean | void,
): Promise<void> {
  const open = `<${tag}`;
  const close = `</${tag}>`;
  const reader = stream.getReader();
  let buffer = '';
  let stopped = false;

  const drain = (final: boolean): void => {
    let cursor = 0;
    for (;;) {
      let start = buffer.indexOf(open, cursor);
      // `<row` must not match `<rowBreaks`, nor `<c` match `<col`.
      while (start >= 0) {
        const next = buffer.charCodeAt(start + open.length);
        if (next === 32 || next === 62 || next === 47 || next === 9 || next === 10 || next === 13) break;
        if (Number.isNaN(next)) break;
        start = buffer.indexOf(open, start + 1);
      }
      if (start < 0) {
        // Keep a tail long enough to hold a split opening tag.
        cursor = final ? buffer.length : Math.max(cursor, buffer.length - open.length);
        break;
      }
      const headEnd = buffer.indexOf('>', start);
      if (headEnd < 0) {
        cursor = start;
        break;
      }
      let end: number;
      if (buffer.charCodeAt(headEnd - 1) === 47 /* / */) end = headEnd + 1;
      else {
        const closeAt = buffer.indexOf(close, headEnd);
        if (closeAt < 0) {
          cursor = start;
          break;
        }
        end = closeAt + close.length;
      }
      if (onElement(buffer.slice(start, end)) === false) {
        stopped = true;
        return;
      }
      cursor = end;
    }
    buffer = buffer.slice(cursor);
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += value;
      drain(false);
      if (stopped) break;
    }
    if (!stopped) drain(true);
  } finally {
    if (stopped) await reader.cancel().catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// XML text
// ---------------------------------------------------------------------------

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

export function decodeXml(text: string): string {
  if (text.indexOf('&') < 0 && text.indexOf('_x') < 0) return text;
  return text
    .replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_, code: string) => {
      if (code[0] === '#') {
        const n = code[1] === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
        return String.fromCodePoint(n);
      }
      return ENTITIES[code] ?? '';
    })
    // Excel escapes control characters as _xHHHH_ inside string content.
    .replace(/_x([0-9A-Fa-f]{4})_/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

/** All `<t>` text in a string item or inline string, ignoring phonetic runs. */
function textOf(xml: string): string {
  const withoutPhonetic = xml.indexOf('<rPh') >= 0 ? xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '') : xml;
  let out = '';
  const re = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(withoutPhonetic)) !== null) out += m[1];
  return decodeXml(out);
}

function attr(head: string, name: string): string | undefined {
  const re = new RegExp(`\\s${name}="([^"]*)"`);
  return re.exec(head)?.[1];
}

/** "A" → 0, "Z" → 25, "AA" → 26. */
export function columnIndex(ref: string): number {
  let n = 0;
  for (let i = 0; i < ref.length; i += 1) {
    const c = ref.charCodeAt(i);
    if (c >= 65 && c <= 90) n = n * 26 + (c - 64);
    else if (c >= 97 && c <= 122) n = n * 26 + (c - 96);
    else break;
  }
  return n - 1;
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

/** Built-in number formats that are dates or times. */
const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 30, 36, 45, 46, 47, 50, 57]);

function isDateFormatCode(code: string): boolean {
  // Strip quoted literals, escapes and colour/condition brackets, then look for
  // a date or time token. `[h]` elapsed-time formats count as times.
  const bare = code.replace(/"[^"]*"/g, '').replace(/\\./g, '').replace(/\[(?!h\]|m\]|s\])[^\]]*\]/gi, '');
  return /[ymdhs]/i.test(bare) && !/^[#0.,%E+\-\s]*$/.test(bare);
}

/** Which cell style indexes format their number as a date. */
function dateStyles(stylesXml: string): Set<number> {
  const custom = new Map<number, string>();
  for (const m of stylesXml.matchAll(/<numFmt\b[^>]*numFmtId="(\d+)"[^>]*formatCode="([^"]*)"/g)) {
    custom.set(Number(m[1]), decodeXml(m[2] ?? ''));
  }
  const out = new Set<number>();
  const cellXfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(stylesXml)?.[1] ?? '';
  let index = 0;
  for (const m of cellXfs.matchAll(/<xf\b([^>]*?)(?:\/>|>)/g)) {
    const id = Number(attr(m[1] ?? '', 'numFmtId') ?? '0');
    const code = custom.get(id);
    if (BUILTIN_DATE_FORMATS.has(id) || (code !== undefined && isDateFormatCode(code))) out.add(index);
    index += 1;
  }
  return out;
}

/**
 * An Excel serial date as ISO 8601, without a zone — Excel does not record
 * one, and inventing UTC would shift every time by the collector's offset.
 */
export function excelSerialToIso(serial: number, date1904 = false): string {
  const epoch = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
  const ms = Math.round(serial * 86_400_000);
  const iso = new Date(epoch + ms).toISOString();
  // Whole days read better as dates.
  return Number.isInteger(serial) ? iso.slice(0, 10) : iso.slice(0, 19);
}

// ---------------------------------------------------------------------------
// Workbook
// ---------------------------------------------------------------------------

export async function openXlsx(data: Uint8Array | ArrayBuffer): Promise<XlsxWorkbook> {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const entries = readZipDirectory(bytes);
  const need = (name: string): ZipEntry => {
    const entry = entries.get(name);
    if (!entry) throw new XlsxError(`Not an Excel workbook: ${name} is missing.`);
    return entry;
  };

  const workbookXml = await entryString(bytes, need('xl/workbook.xml'));
  const relsXml = await entryString(bytes, need('xl/_rels/workbook.xml.rels'));
  const date1904 = /<workbookPr\b[^>]*date1904="(1|true)"/.test(workbookXml);

  // Sheet names map to files through relationship ids, and the files are not
  // numbered in tab order — sheet17 can follow sheet20.
  const targets = new Map<string, string>();
  for (const m of relsXml.matchAll(/<Relationship\b([^>]*)\/?>/g)) {
    const id = attr(m[1] ?? '', 'Id');
    const target = attr(m[1] ?? '', 'Target');
    if (!id || !target) continue;
    const path = target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`;
    targets.set(id, path);
  }
  const sheetPaths = new Map<string, string>();
  const sheets: string[] = [];
  for (const m of workbookXml.matchAll(/<sheet\b([^>]*)\/?>/g)) {
    const head = m[1] ?? '';
    const name = decodeXml(attr(head, 'name') ?? '');
    const rid = /\sr:id="([^"]*)"/.exec(head)?.[1] ?? '';
    const path = targets.get(rid);
    if (name && path && entries.has(path)) {
      sheets.push(name);
      sheetPaths.set(name, path);
    }
  }

  const stylesEntry = entries.get('xl/styles.xml');
  const dates = stylesEntry ? dateStyles(await entryString(bytes, stylesEntry)) : new Set<number>();

  let shared: string[] | null = null;
  async function sharedStrings(): Promise<string[]> {
    if (shared) return shared;
    const list: string[] = [];
    const entry = entries.get('xl/sharedStrings.xml');
    if (entry) {
      await eachElement(entryText(bytes, entry), 'si', (xml) => {
        list.push(textOf(xml));
      });
    }
    shared = list;
    return list;
  }

  async function rows(
    sheet: string,
    onRow: (cells: string[], index: number) => boolean | void,
  ): Promise<number> {
    const path = sheetPaths.get(sheet);
    if (!path) throw new XlsxError(`The workbook has no tab called ${sheet}.`);
    const strings = await sharedStrings();
    const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let delivered = 0;
    let expectedRow = 1;

    await eachElement(entryText(bytes, need(path)), 'row', (rowXml) => {
      // A row number that skips ahead means blank rows in between. They are
      // not delivered — a blank row carries nothing — but indexes stay honest.
      const rowNumber = Number(/\sr="(\d+)"/.exec(rowXml.slice(0, rowXml.indexOf('>')))?.[1] ?? expectedRow);
      expectedRow = rowNumber + 1;

      const cells: string[] = [];
      let next = 0;
      cellRe.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = cellRe.exec(rowXml)) !== null) {
        const head = m[1] ?? '';
        const body = m[2] ?? '';
        const ref = attr(head, 'r');
        const column = ref ? columnIndex(ref) : next;
        next = column + 1;
        if (!body) continue;

        const type = attr(head, 't');
        let value: string;
        if (type === 'inlineStr') value = textOf(body);
        else {
          const raw = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
          if (raw === undefined) continue;
          if (type === 's') value = strings[Number(raw)] ?? '';
          else if (type === 'b') value = raw === '1' ? 'True' : 'False';
          else if (type === 'str' || type === 'e') value = decodeXml(raw);
          else {
            const style = Number(attr(head, 's') ?? '-1');
            const n = Number(raw);
            value = dates.has(style) && Number.isFinite(n) && n > 0 ? excelSerialToIso(n, date1904) : raw;
          }
        }
        while (cells.length < column) cells.push('');
        cells[column] = value;
      }
      if (cells.length === 0) return;
      const keepGoing = onRow(cells, delivered);
      delivered += 1;
      return keepGoing;
    });
    return delivered;
  }

  return { sheets, rows };
}

/** Whether these bytes look like a zip, which is what an .xlsx is. */
export function looksLikeXlsx(bytes: Uint8Array): boolean {
  return bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}
