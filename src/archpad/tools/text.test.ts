/** Text tools and the regex tester. */

import { describe, it } from 'node:test';
import { expect } from '../../testing/expect.ts';
import { addLineNumbers, convertTimestamp, escapeText, loremIpsum, removeLineNumbers, textStats, unescapeText, uuidV4, wrapLines, type EscapeStyle } from './text.ts';
import { findMatches, parsePattern, regexReplace } from './regex.ts';

describe('textStats', () => {
  it('counts words, characters, bytes and lines', () => {
    const s = textStats('héllo world\n\n🌍 x\n');
    expect(s.words).toBe(4);
    expect(s.characters).toBe(17);
    expect(s.utf16Units).toBe(18);
    expect(s.bytesUtf8).toBe(21);
    expect(s.lines).toBe(4);
    expect(s.nonBlankLines).toBe(2);
    expect(s.paragraphs).toBe(2);
  });
});

describe('uuidV4', () => {
  it('is version 4, variant 1', () => {
    expect(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(uuidV4())).toBe(true);
  });
});

describe('convertTimestamp', () => {
  it('reads the unit from the digit count', () => {
    expect(convertTimestamp('1700000000').isoUtc).toBe('2023-11-14T22:13:20.000Z');
    expect(convertTimestamp('1700000000123').ms).toBe(1700000000123);
    expect(convertTimestamp('1700000000123456').readAs).toBe('epoch microseconds');
    expect(convertTimestamp('2023-11-14T22:13:20Z').seconds).toBe(1700000000);
    expect(() => convertTimestamp('not a date')).toThrow(/not an epoch/);
  });
});

describe('lorem, line numbers, wrapping', () => {
  it('generates the same text for the same count', () => {
    expect(loremIpsum(2)).toBe(loremIpsum(2));
    expect(loremIpsum(2).split('\n\n')).toHaveLength(2);
    expect(loremIpsum(1).startsWith('Lorem ipsum dolor sit amet')).toBe(true);
  });

  it('adds and removes line numbers', () => {
    const text = Array.from({ length: 10 }, (_, i) => `line ${i}`).join('\n');
    const numbered = addLineNumbers(text);
    expect(numbered.split('\n')[0]).toBe(' 1 line 0');
    expect(numbered.split('\n')[9]).toBe('10 line 9');
    expect(removeLineNumbers(numbered)).toBe(text);
    expect(removeLineNumbers('12: a\n3. b\n4)\tc')).toBe('a\nb\nc');
  });

  it('wraps on spaces, keeping indent', () => {
    expect(wrapLines('  one two three four', 10)).toBe('  one two\n  three\n  four');
    expect(wrapLines('short', 10)).toBe('short');
    expect(wrapLines('averyveryverylongword x', 5)).toBe('averyveryverylongword\nx');
  });
});

describe('escape and unescape', () => {
  const sample = 'He said "hi"\\ it\'s\ttabbed\nnew $line (1+1)';
  for (const style of ['json', 'regex', 'csharp', 'java', 'sql', 'shell'] as EscapeStyle[]) {
    it(`round-trips ${style}`, () => {
      expect(unescapeText(escapeText(sample, style), style)).toBe(sample);
    });
  }

  it('escapes as each language writes it', () => {
    expect(escapeText('a"b\n', 'json')).toBe('a\\"b\\n');
    expect(escapeText('1.5*(x)', 'regex')).toBe('1\\.5\\*\\(x\\)');
    expect(escapeText("O'Brien", 'sql')).toBe("O''Brien");
    expect(escapeText("it's", 'shell')).toBe("'it'\\''s'");
    expect(unescapeText('\\u00e9\\x41\\101', 'java')).toBe('éAA');
    expect(unescapeText('"quoted\\n"', 'json')).toBe('quoted\n');
  });
});

describe('regex tester', () => {
  it('lists matches with position and groups', () => {
    const re = parsePattern('(?<user>\\w+)@(\\w+)\\.com', 'g');
    const { matches } = findMatches('a@b.com\n  cc@dd.com', re);
    expect(matches).toHaveLength(2);
    expect(matches[1]!.line).toBe(2);
    expect(matches[1]!.column).toBe(3);
    expect(matches[1]!.groups).toEqual(['cc', 'dd']);
    expect(matches[1]!.named).toEqual({ user: 'cc' });
  });

  it('accepts /pattern/flags and reports a bad pattern', () => {
    expect(parsePattern('/ab+/i').flags).toBe('i');
    expect(() => parsePattern('(')).toThrow(/Invalid pattern/);
  });

  it('does not hang on empty matches and caps the list', () => {
    const r = findMatches('x'.repeat(100), /y*/g, 10);
    expect(r.matches).toHaveLength(10);
    expect(r.truncated).toBe(true);
  });

  it('replaces with $-references and counts', () => {
    expect(regexReplace('a1 b2', /([a-z])(\d)/g, '$2$1')).toEqual({ text: '1a 2b', count: 2 });
    expect(regexReplace('a1 b2', /(\d)/, '#').count).toBe(1);
  });
});
