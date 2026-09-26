import { describe, it } from 'node:test';
import { expect } from '../testing/expect.ts';
import { openXlsx } from '../core/xlsx.ts';
import { openZip } from '../core/zip.ts';
import {
  cleanSheetName, columnLetter, sheetFromRecords, uniqueSheetNames, writeXlsx, xlsxParts, xmlText, type XlsxCellValue, type XlsxSheet,
} from './xlsx-write.ts';

const same = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

/** Every row of every tab, as the reader returns them. */
async function readBack(bytes: Uint8Array): Promise<Record<string, string[][]>> {
  const book = await openXlsx(bytes);
  const out: Record<string, string[][]> = {};
  for (const sheet of book.sheets) {
    const rows: string[][] = [];
    await book.rows(sheet, (cells) => {
      rows.push(cells);
    });
    out[sheet] = rows;
  }
  return out;
}

/** What the reader should give back for a row: text of each value, trailing blanks dropped. */
function expected(rows: readonly (readonly XlsxCellValue[])[]): string[][] {
  const out: string[][] = [];
  for (const row of rows) {
    const cells = row.map((v) => (v === null || v === undefined ? '' : typeof v === 'boolean' ? (v ? 'True' : 'False') : String(v)));
    while (cells.length > 0 && cells[cells.length - 1] === '') cells.pop();
    if (cells.length > 0) out.push(cells);
  }
  return out;
}

const AWKWARD: XlsxSheet = {
  name: 'Grid: awkward/values?',
  rows: [
    ['Name', 'Count', 'Ok', 'Note', 'Formula-looking'],
    ['web-01', 4, true, '  leading and trailing  ', '=SUM(A1:A2)'],
    ['db <&> "01"', 16.5, false, 'line one\nline two', '_x0041_ stays literal'],
    ['ctrl\u0001char', -3, null, '', 'ünïcödé ✓ 2001:db8::1'],
    ['', '', '', '', 'only the last cell'],
  ],
};

describe('xlsx-write', () => {
  it('re-opens with core/xlsx.ts openXlsx with identical cells (inline strings, stored)', async () => {
    const bytes = await writeXlsx([AWKWARD, { name: 'Second', rows: [['a', 'b'], [1, 2]] }]);
    const back = await readBack(bytes);
    expect(Object.keys(back)).toEqual(['Grid awkward values', 'Second']);
    expect(back['Grid awkward values']).toEqual(expected(AWKWARD.rows));
    expect(back.Second).toEqual([['a', 'b'], ['1', '2']]);
  });

  it('re-opens identically with shared strings and deflated entries', async () => {
    const bytes = await writeXlsx([AWKWARD], { strings: 'shared', compression: 'deflate' });
    const archive = openZip(bytes);
    expect(archive.entries.every((e) => e.method === 8)).toBe(true);
    expect(archive.has('xl/sharedStrings.xml')).toBe(true);
    const back = await readBack(bytes);
    expect(back['Grid awkward values']).toEqual(expected(AWKWARD.rows));
  });

  it('is byte-identical across two runs, and in any time zone', async () => {
    const when = '2026-09-26T10:15:30.000Z';
    const a = await writeXlsx([AWKWARD], { when });
    const b = await writeXlsx([AWKWARD], { when });
    expect(same(a, b)).toBe(true);
    const c = await writeXlsx([AWKWARD], { when, compression: 'deflate' });
    const d = await writeXlsx([AWKWARD], { when, compression: 'deflate' });
    expect(same(c, d)).toBe(true);
    // The DOS stamp is the UTC wall clock of `when`: 10:15:30 on 2026-09-26.
    const view = new DataView(a.buffer, a.byteOffset);
    expect(view.getUint16(10, true)).toBe((10 << 11) | (15 << 5) | 15);
    expect(view.getUint16(12, true)).toBe(((2026 - 1980) << 9) | (9 << 5) | 26);
  });

  it('writes a styled, frozen header row and no footprints', async () => {
    const parts = xlsxParts([AWKWARD]);
    const sheet = parts['xl/worksheets/sheet1.xml'] ?? '';
    expect(sheet).toContain('state="frozen"');
    expect(sheet).toContain('<c r="A1" s="1" t="inlineStr">');
    expect(parts['xl/styles.xml']).toContain('<b/>');
    expect(Object.keys(parts).some((p) => p.startsWith('docProps/'))).toBe(false);
    expect(Object.values(parts).join('')).not.toContain('<f>');
    const plain = xlsxParts([{ name: 'x', rows: [['a']], header: false }]);
    expect(plain['xl/worksheets/sheet1.xml']).not.toContain('frozen');
  });

  it('cleans and de-duplicates tab names', () => {
    expect(cleanSheetName('a/b:c*d?e[f]')).toBe('a b c d e f');
    expect(cleanSheetName('')).toBe('Sheet');
    expect(cleanSheetName('x'.repeat(40))).toHaveLength(31);
    expect(uniqueSheetNames(['Risks', 'risks', 'Risks'])).toEqual(['Risks', 'risks (2)', 'Risks (3)']);
  });

  it('names columns past Z and escapes text', () => {
    expect(columnLetter(0)).toBe('A');
    expect(columnLetter(25)).toBe('Z');
    expect(columnLetter(26)).toBe('AA');
    expect(columnLetter(701)).toBe('ZZ');
    expect(columnLetter(702)).toBe('AAA');
    expect(xmlText('a<b>&\u0002')).toBe('a&lt;b&gt;&amp;_x0002_');
  });

  it('builds a sheet from records in column order', async () => {
    const sheet = sheetFromRecords('Risks', ['id', 'risk'], [{ risk: 'late', id: 'R1' }], ['ID', 'Risk']);
    const back = await readBack(await writeXlsx([sheet]));
    expect(back.Risks).toEqual([['ID', 'Risk'], ['R1', 'late']]);
  });

  it('writes an empty workbook that still opens', async () => {
    const back = await readBack(await writeXlsx([]));
    expect(Object.keys(back)).toEqual(['Sheet1']);
  });
});
