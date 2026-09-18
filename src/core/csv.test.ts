import { describe, it } from 'node:test';
import { expect } from '../testing/expect.ts';
import {
  parseCsv,
  parseCsvRecords,
  detectDelimiter,
  parseNumber,
  parseBoolean,
  pick,
  pickNumber,
  toCsv,
} from './csv.ts';

describe('parseCsv', () => {
  it('parses a simple table', () => {
    const table = parseCsv('a,b,c\n1,2,3\n4,5,6');
    expect(table.headers).toEqual(['a', 'b', 'c']);
    expect(table.rows).toEqual([
      ['1', '2', '3'],
      ['4', '5', '6'],
    ]);
  });

  it('handles quoted fields containing the delimiter', () => {
    const table = parseCsv('name,note\n"vm-01","Migrated, pending review"');
    expect(table.rows[0]).toEqual(['vm-01', 'Migrated, pending review']);
  });

  it('handles escaped quotes inside quoted fields', () => {
    const table = parseCsv('name,note\n"vm-01","He said ""hello"" twice"');
    expect(table.rows[0]?.[1]).toBe('He said "hello" twice');
  });

  it('handles newlines inside quoted fields', () => {
    const table = parseCsv('name,note\n"vm-01","line one\nline two"\n"vm-02","ok"');
    expect(table.rows).toHaveLength(2);
    expect(table.rows[0]?.[1]).toBe('line one\nline two');
    expect(table.rows[1]?.[0]).toBe('vm-02');
  });

  it('handles CRLF line endings', () => {
    const table = parseCsv('a,b\r\n1,2\r\n3,4\r\n');
    expect(table.rows).toEqual([
      ['1', '2'],
      ['3', '4'],
    ]);
  });

  it('strips a UTF-8 BOM, as Excel emits', () => {
    const table = parseCsv('﻿Host,Cluster\nesx01,cl01');
    expect(table.headers).toEqual(['Host', 'Cluster']);
  });

  it('keeps a row without a trailing newline', () => {
    const table = parseCsv('a,b\n1,2');
    expect(table.rows).toHaveLength(1);
  });

  it('preserves empty fields in position', () => {
    const table = parseCsv('a,b,c\n1,,3');
    expect(table.rows[0]).toEqual(['1', '', '3']);
  });

  it('skips fully blank rows by default', () => {
    const table = parseCsv('a,b\n1,2\n\n3,4\n\n');
    expect(table.rows).toHaveLength(2);
  });

  it('can keep headers as a data row', () => {
    const table = parseCsv('a,b\n1,2', { headers: false });
    expect(table.headers).toEqual([]);
    expect(table.rows).toHaveLength(2);
  });
});

describe('detectDelimiter', () => {
  it('detects commas', () => {
    expect(detectDelimiter('a,b,c\n1,2,3')).toBe(',');
  });

  it('detects semicolons from European exports', () => {
    expect(detectDelimiter('a;b;c\n1;2;3')).toBe(';');
  });

  it('detects tabs', () => {
    expect(detectDelimiter('a\tb\tc\n1\t2\t3')).toBe('\t');
  });

  it('ignores delimiters inside quoted headers', () => {
    // One real semicolon, but three commas inside a quoted header.
    expect(detectDelimiter('"a,b,c,d";e')).toBe(';');
  });

  it('parses a semicolon file end to end', () => {
    const records = parseCsvRecords('Host;Cores\nesx01;32');
    expect(records[0]).toEqual({ Host: 'esx01', Cores: '32' });
  });
});

describe('parseNumber', () => {
  it('parses plain numbers', () => {
    expect(parseNumber('42')).toBe(42);
    expect(parseNumber('3.5')).toBe(3.5);
    expect(parseNumber('-7')).toBe(-7);
  });

  it('strips thousands separators', () => {
    expect(parseNumber('1,048,576')).toBe(1048576);
  });

  it('handles European decimal commas', () => {
    expect(parseNumber('1.234,56')).toBe(1234.56);
    expect(parseNumber('3,5')).toBe(3.5);
  });

  it('distinguishes multiple commas as thousands from a single decimal comma', () => {
    // Two commas can only be thousands separators.
    expect(parseNumber('1,048,576')).toBe(1048576);
    // Exactly three digits after a lone comma is a thousands group.
    expect(parseNumber('1,048')).toBe(1048);
    // Anything else after a lone comma is a decimal mark.
    expect(parseNumber('12,75')).toBe(12.75);
  });

  it('handles multiple dots as European thousands separators', () => {
    expect(parseNumber('1.048.576')).toBe(1048576);
  });

  it('parses large RVTools capacity values', () => {
    // vDatastore "Capacity MiB" on a big array.
    expect(parseNumber('41,943,040')).toBe(41943040);
  });

  it('strips a trailing percent sign', () => {
    expect(parseNumber('85%')).toBe(85);
  });

  it('treats parentheses as negative', () => {
    expect(parseNumber('(12)')).toBe(-12);
  });

  it('returns null for empty and placeholder values rather than NaN', () => {
    expect(parseNumber('')).toBeNull();
    expect(parseNumber('   ')).toBeNull();
    expect(parseNumber('-')).toBeNull();
    expect(parseNumber('N/A')).toBeNull();
    expect(parseNumber('n/a')).toBeNull();
    expect(parseNumber('null')).toBeNull();
    expect(parseNumber(undefined)).toBeNull();
    expect(parseNumber('abc')).toBeNull();
  });
});

describe('parseBoolean', () => {
  it('accepts common truthy and falsy spellings', () => {
    expect(parseBoolean('True')).toBe(true);
    expect(parseBoolean('yes')).toBe(true);
    expect(parseBoolean('enabled')).toBe(true);
    expect(parseBoolean('1')).toBe(true);
    expect(parseBoolean('False')).toBe(false);
    expect(parseBoolean('no')).toBe(false);
    expect(parseBoolean('0')).toBe(false);
  });

  it('returns null for anything else', () => {
    expect(parseBoolean('')).toBeNull();
    expect(parseBoolean('maybe')).toBeNull();
  });
});

describe('pick', () => {
  const record = { 'CPU Model': 'Xeon Gold 6338', '# Cores': '32', Empty: '' };

  it('finds an exact header', () => {
    expect(pick(record, 'CPU Model')).toBe('Xeon Gold 6338');
  });

  it('falls back through candidates in order', () => {
    expect(pick(record, 'Processor', 'CPU Model')).toBe('Xeon Gold 6338');
  });

  it('matches ignoring case, spaces and punctuation', () => {
    // Real exports rename "# Cores" to "Cores" between versions.
    expect(pick(record, 'cores')).toBe('32');
    expect(pick(record, 'cpumodel')).toBe('Xeon Gold 6338');
  });

  it('skips empty values and keeps looking', () => {
    expect(pick(record, 'Empty', 'CPU Model')).toBe('Xeon Gold 6338');
  });

  it('returns undefined when nothing matches', () => {
    expect(pick(record, 'Nonexistent')).toBeUndefined();
  });

  it('coerces through pickNumber', () => {
    expect(pickNumber(record, '# Cores')).toBe(32);
    expect(pickNumber(record, 'Nonexistent')).toBeNull();
  });
});

describe('toCsv', () => {
  it('writes headers and rows', () => {
    expect(toCsv([{ a: 1, b: 2 }])).toBe('a,b\n1,2\n');
  });

  it('quotes fields containing the delimiter or newlines', () => {
    const csv = toCsv([{ name: 'vm-01', note: 'a, b' }]);
    expect(csv).toContain('"a, b"');
  });

  it('doubles embedded quotes', () => {
    expect(toCsv([{ note: 'say "hi"' }])).toContain('"say ""hi"""');
  });

  it('returns an empty string for no records', () => {
    expect(toCsv([])).toBe('');
  });

  it('round-trips through the parser', () => {
    const original = [
      { name: 'vm-01', note: 'has, comma' },
      { name: 'vm-02', note: 'has "quotes"' },
    ];
    const parsed = parseCsvRecords(toCsv(original));
    expect(parsed).toEqual(original.map((r) => ({ name: r.name, note: r.note })));
  });
});
