/**
 * Text tools: counts, UUIDs, timestamps, lorem ipsum, line numbers, hard
 * wrapping, and escaping for the string syntaxes people paste between.
 */

import { utf8 } from './encode.ts';

// --- Counts ----------------------------------------------------------------------

export interface TextStats {
  readonly characters: number;
  readonly charactersNoSpaces: number;
  /** UTF-16 code units — what JavaScript's .length and most length limits count. */
  readonly utf16Units: number;
  readonly words: number;
  readonly lines: number;
  readonly nonBlankLines: number;
  readonly bytesUtf8: number;
  readonly paragraphs: number;
  readonly longestLine: number;
}

export function textStats(text: string): TextStats {
  const lines = text === '' ? [] : text.split(/\r\n|\r|\n/);
  return {
    characters: [...text].length,
    charactersNoSpaces: [...text.replace(/\s+/g, '')].length,
    utf16Units: text.length,
    words: (text.match(/\S+/g) ?? []).length,
    lines: text === '' ? 0 : lines.length,
    nonBlankLines: lines.filter((l) => l.trim()).length,
    bytesUtf8: utf8(text).length,
    paragraphs: text.split(/(?:\r?\n[ \t]*){2,}/).filter((p) => p.trim()).length,
    longestLine: lines.reduce((m, l) => Math.max(m, [...l].length), 0),
  };
}

// --- UUID -------------------------------------------------------------------------

/** RFC 4122 version 4. randomUUID needs a secure context; getRandomValues does not. */
export function uuidV4(): string {
  const c = globalThis.crypto;
  if (typeof c?.randomUUID === 'function') return c.randomUUID();
  const b = new Uint8Array(16);
  c.getRandomValues(b);
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// --- Timestamps -------------------------------------------------------------------

export interface TimestampInfo {
  readonly input: string;
  /** How the input was read, e.g. "epoch seconds". */
  readonly readAs: string;
  readonly ms: number;
  readonly seconds: number;
  readonly isoUtc: string;
  readonly local: string;
  readonly relative: string;
}

function relative(ms: number, now: number): string {
  const diff = ms - now;
  const abs = Math.abs(diff);
  const units: [string, number][] = [['year', 31_557_600_000], ['day', 86_400_000], ['hour', 3_600_000], ['minute', 60_000], ['second', 1000]];
  for (const [name, size] of units) {
    if (abs >= size) {
      const n = Math.floor(abs / size);
      return `${n} ${name}${n === 1 ? '' : 's'} ${diff < 0 ? 'ago' : 'from now'}`;
    }
  }
  return 'now';
}

/**
 * Read an epoch (the digit count decides the unit: ≤11 seconds, 12–14
 * milliseconds, 15–17 microseconds, 18+ nanoseconds) or a date string.
 */
export function convertTimestamp(input: string, now = Date.now()): TimestampInfo {
  const t = input.trim();
  let ms: number;
  let readAs: string;
  if (/^-?\d+(\.\d+)?$/.test(t)) {
    const digits = t.replace(/^-/, '').split('.')[0]!.length;
    const n = Number(t);
    if (digits <= 11) [ms, readAs] = [n * 1000, 'epoch seconds'];
    else if (digits <= 14) [ms, readAs] = [n, 'epoch milliseconds'];
    else if (digits <= 17) [ms, readAs] = [n / 1000, 'epoch microseconds'];
    else [ms, readAs] = [n / 1e6, 'epoch nanoseconds'];
  } else {
    ms = Date.parse(t);
    readAs = 'date';
  }
  if (!Number.isFinite(ms) || Math.abs(ms) > 8.64e15) throw new Error(`"${t}" is not an epoch number or a date the browser can read (try ISO 8601, e.g. 2026-09-24T10:00:00Z).`);
  const d = new Date(ms);
  return {
    input: t,
    readAs,
    ms: Math.round(ms),
    seconds: Math.floor(ms / 1000),
    isoUtc: d.toISOString(),
    local: d.toString(),
    relative: relative(ms, now),
  };
}

// --- Lorem ipsum ------------------------------------------------------------------

const LOREM_FIRST = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.';
const LOREM_WORDS = (
  'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua ' +
  'enim ad minim veniam quis nostrud exercitation ullamco laboris nisi aliquip ex ea commodo consequat duis aute irure in ' +
  'reprehenderit voluptate velit esse cillum fugiat nulla pariatur excepteur sint occaecat cupidatat non proident sunt culpa ' +
  'qui officia deserunt mollit anim id est laborum'
).split(' ');

/**
 * Paragraphs of placeholder text. Seeded, so the same count gives the same
 * text — a diff of two generated files should show only what you changed.
 */
export function loremIpsum(paragraphs = 3, seed = 1): string {
  let s = seed >>> 0 || 1;
  const rand = (): number => {
    // xorshift32: small, and deterministic across engines.
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 0x100000000;
  };
  const sentence = (): string => {
    const n = 6 + Math.floor(rand() * 10);
    const words = Array.from({ length: n }, () => LOREM_WORDS[Math.floor(rand() * LOREM_WORDS.length)]!);
    if (n > 8) words[Math.floor(n / 2)] += ',';
    const text = words.join(' ');
    return `${text[0]!.toUpperCase()}${text.slice(1)}.`;
  };
  const out: string[] = [];
  for (let p = 0; p < Math.max(1, paragraphs); p += 1) {
    const count = 4 + Math.floor(rand() * 4);
    const sentences = Array.from({ length: count }, sentence);
    if (p === 0) sentences[0] = LOREM_FIRST;
    out.push(sentences.join(' '));
  }
  return out.join('\n\n');
}

// --- Line numbers -----------------------------------------------------------------

/** "1 first", padded so the text lines up: " 9 ...", "10 ...". */
export function addLineNumbers(text: string, start = 1, separator = ' '): string {
  const lines = text.split('\n');
  const width = String(start + lines.length - 1).length;
  return lines.map((l, i) => `${String(start + i).padStart(width)}${separator}${l}`).join('\n');
}

/**
 * Strip a leading number and its separator — "12 ", "12: ", "12. ", "12) ",
 * "12| ", "12\t" — whether ArchPad added it or it came from a listing.
 */
export function removeLineNumbers(text: string): string {
  return text
    .split('\n')
    .map((l) => l.replace(/^[ \t]*\d+(?:[.:)|\]][ \t]?|[ \t]|$)/, ''))
    .join('\n');
}

// --- Hard wrap --------------------------------------------------------------------

/**
 * Wrap each line at `width` columns on spaces, keeping its indent on the
 * continuation lines. A word longer than the width gets a line to itself
 * rather than being cut (it is probably a URL or a hash).
 */
export function wrapLines(text: string, width: number): string {
  if (!Number.isInteger(width) || width < 1) throw new Error('The width must be a whole number above 0.');
  return text
    .split('\n')
    .map((line) => {
      if (line.length <= width) return line;
      const indent = /^[ \t]*/.exec(line)![0];
      const words = line.slice(indent.length).split(/ +/);
      const out: string[] = [];
      let current = indent;
      for (const w of words) {
        if (current.trim() && current.length + 1 + w.length > width) {
          out.push(current);
          current = indent + w;
        } else current = current.trim() ? `${current} ${w}` : indent + w;
      }
      out.push(current);
      return out.join('\n');
    })
    .join('\n');
}

// --- Escaping ---------------------------------------------------------------------

export type EscapeStyle = 'json' | 'regex' | 'csharp' | 'java' | 'sql' | 'shell';

export const ESCAPE_STYLES: readonly { id: EscapeStyle; label: string }[] = [
  { id: 'json', label: 'JSON string' },
  { id: 'regex', label: 'Regular expression' },
  { id: 'csharp', label: 'C# string' },
  { id: 'java', label: 'Java string' },
  { id: 'sql', label: 'SQL string' },
  { id: 'shell', label: 'Shell (POSIX single quotes)' },
];

const cLike = (text: string): string =>
  text.replace(/[\\"\n\r\t\0\b\f\u0001-\u001f\u007f\u{2028}\u{2029}]/gu, (c) => {
    switch (c) {
      case '\\': return '\\\\';
      case '"': return '\\"';
      case '\n': return '\\n';
      case '\r': return '\\r';
      case '\t': return '\\t';
      case '\0': return '\\0';
      case '\b': return '\\b';
      case '\f': return '\\f';
      default: return `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`;
    }
  });

function cLikeUnescape(text: string): string {
  return text.replace(/\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|x[0-9a-fA-F]{1,4}|[0-7]{1,3}|.)/gs, (_, e: string) => {
    switch (e[0]) {
      case 'n': return '\n';
      case 'r': return '\r';
      case 't': return '\t';
      case 'b': return '\b';
      case 'f': return '\f';
      case 'v': return '\v';
      case 'a': return '\u0007';
      case 'u':
        return String.fromCodePoint(parseInt(e.startsWith('u{') ? e.slice(2, -1) : e.slice(1), 16));
      case 'U':
        return String.fromCodePoint(parseInt(e.slice(1), 16));
      case 'x':
        return String.fromCharCode(parseInt(e.slice(1), 16));
      default:
        if (/^[0-7]+$/.test(e)) return String.fromCharCode(parseInt(e, 8));
        return e; // \\ \" \' and any other escaped character stand for themselves
    }
  });
}

/** POSIX shell: split words, honouring '...', "...", and backslashes, then join with spaces. */
function shellUnescape(text: string): string {
  let out = '';
  let i = 0;
  const t = text.trim();
  while (i < t.length) {
    const c = t[i]!;
    if (c === "'") {
      const j = t.indexOf("'", i + 1);
      if (j < 0) throw new Error('Unterminated single quote.');
      out += t.slice(i + 1, j);
      i = j + 1;
    } else if (c === '"') {
      i += 1;
      while (i < t.length && t[i] !== '"') {
        if (t[i] === '\\' && '$`"\\\n'.includes(t[i + 1] ?? '')) i += 1;
        out += t[i];
        i += 1;
      }
      if (i >= t.length) throw new Error('Unterminated double quote.');
      i += 1;
    } else if (c === '\\') {
      out += t[i + 1] ?? '';
      i += 2;
    } else {
      out += c;
      i += 1;
    }
  }
  return out;
}

export function escapeText(text: string, style: EscapeStyle): string {
  switch (style) {
    case 'json':
      return JSON.stringify(text).slice(1, -1);
    case 'regex':
      return text.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&');
    case 'csharp':
    case 'java':
      return cLike(text);
    case 'sql':
      return text.replace(/'/g, "''");
    case 'shell':
      // Single quotes make everything literal; a quote itself closes, is escaped, and reopens.
      return `'${text.replace(/'/g, "'\\''")}'`;
  }
}

export function unescapeText(text: string, style: EscapeStyle): string {
  switch (style) {
    case 'json':
      // A selection may include its surrounding quotes, or be just the body.
      if (text.startsWith('"')) {
        try {
          const whole: unknown = JSON.parse(text);
          if (typeof whole === 'string') return whole;
        } catch {
          // Not a complete literal; read it as a body below.
        }
      }
      try {
        return JSON.parse(`"${text.replace(/\r?\n/g, '\\n')}"`) as string;
      } catch {
        throw new Error('Not a valid JSON string body (check backslashes and quotes).');
      }
    case 'regex':
      return text.replace(/\\([.*+?^${}()|[\]\\/-])/g, '$1');
    case 'csharp':
    case 'java':
      return cLikeUnescape(text);
    case 'sql':
      return text.replace(/''/g, "'");
    case 'shell':
      return shellUnescape(text);
  }
}
