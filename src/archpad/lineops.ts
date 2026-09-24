/**
 * Line operations, blank operations, case conversion and the Column Editor's
 * arithmetic: Notepad++'s Edit menu as pure string functions.
 *
 * They take and return arrays of lines (no line endings) so the app decides
 * the range — the selected lines, or the whole document when nothing is
 * selected — and applies the result as one undoable change.
 */

export type SortMode =
  | 'asc'
  | 'desc'
  | 'asc-ci'
  | 'desc-ci'
  | 'num-asc'
  | 'num-desc'
  | 'len-asc'
  | 'len-desc'
  | 'locale-asc'
  | 'locale-desc';

/** The number a line starts with, for numeric sorting. Lines without one sort after every number, as in Notepad++. */
function leadingNumber(line: string): number {
  const m = /^\s*([-+]?(?:\d+(?:[.,]\d*)?|[.,]\d+)(?:e[-+]?\d+)?)/i.exec(line);
  return m ? Number(m[1]!.replace(',', '.')) : Number.NaN;
}

export function sortLines(lines: readonly string[], mode: SortMode): string[] {
  const out = [...lines];
  const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });
  const plain = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  const ci = (a: string, b: string): number => plain(a.toLowerCase(), b.toLowerCase()) || plain(a, b);
  const num = (a: string, b: string): number => {
    const x = leadingNumber(a);
    const y = leadingNumber(b);
    if (Number.isNaN(x) && Number.isNaN(y)) return plain(a, b);
    if (Number.isNaN(x)) return 1;
    if (Number.isNaN(y)) return -1;
    return x - y || plain(a, b);
  };
  const len = (a: string, b: string): number => a.length - b.length;
  // Array.prototype.sort is stable, so equal keys keep their original order.
  switch (mode) {
    case 'asc':
      return out.sort(plain);
    case 'desc':
      return out.sort((a, b) => plain(b, a));
    case 'asc-ci':
      return out.sort(ci);
    case 'desc-ci':
      return out.sort((a, b) => ci(b, a));
    case 'num-asc':
      return out.sort(num);
    case 'num-desc': {
      // Descending still keeps non-numbers last rather than first.
      const numbers = out.filter((l) => !Number.isNaN(leadingNumber(l))).sort((a, b) => num(b, a));
      return [...numbers, ...out.filter((l) => Number.isNaN(leadingNumber(l)))];
    }
    case 'len-asc':
      return out.sort(len);
    case 'len-desc':
      return out.sort((a, b) => len(b, a));
    case 'locale-asc':
      return out.sort((a, b) => collator.compare(a, b));
    case 'locale-desc':
      return out.sort((a, b) => collator.compare(b, a));
  }
}

/** Remove duplicate lines anywhere, keeping the first of each. */
export function removeDuplicates(lines: readonly string[]): string[] {
  const seen = new Set<string>();
  return lines.filter((l) => (seen.has(l) ? false : (seen.add(l), true)));
}

/** Remove a line when it repeats the line directly above it. */
export function removeConsecutiveDuplicates(lines: readonly string[]): string[] {
  return lines.filter((l, i) => i === 0 || l !== lines[i - 1]);
}

/** Remove lines with no characters at all. */
export function removeEmptyLines(lines: readonly string[]): string[] {
  return lines.filter((l) => l.length > 0);
}

/** Remove lines that are empty or only whitespace. */
export function removeBlankLines(lines: readonly string[]): string[] {
  return lines.filter((l) => l.trim().length > 0);
}

export function reverseLines(lines: readonly string[]): string[] {
  return [...lines].reverse();
}

/** Join into one line: each following line loses its indentation and they meet at a single space. */
export function joinLines(lines: readonly string[]): string[] {
  if (lines.length === 0) return [];
  let out = lines[0]!.replace(/\s+$/, '');
  for (const l of lines.slice(1)) {
    const t = l.trim();
    if (!t) continue;
    out = out ? `${out} ${t}` : t;
  }
  return [out];
}

/** Split lines longer than `width` at spaces (a word longer than the width stays whole). */
export function splitLines(lines: readonly string[], width: number): string[] {
  const out: string[] = [];
  const w = Math.max(1, Math.floor(width));
  for (const line of lines) {
    if (line.length <= w) {
      out.push(line);
      continue;
    }
    const indent = /^\s*/.exec(line)![0];
    const words = line.slice(indent.length).split(/ +/);
    let cur = indent;
    for (const word of words) {
      if (cur.trim() && cur.length + 1 + word.length > w) {
        out.push(cur);
        cur = indent + word;
      } else cur = cur.trim() ? `${cur} ${word}` : indent + word;
    }
    out.push(cur);
  }
  return out;
}

export const trimTrailing = (lines: readonly string[]): string[] => lines.map((l) => l.replace(/[ \t\f\v ]+$/, ''));
export const trimLeading = (lines: readonly string[]): string[] => lines.map((l) => l.replace(/^[ \t\f\v ]+/, ''));
export const trimBoth = (lines: readonly string[]): string[] => trimLeading(trimTrailing(lines));

/** Tabs to spaces, honouring tab stops (a tab after 3 characters with size 4 is one space). */
export function tabsToSpaces(lines: readonly string[], tabSize: number, leadingOnly = false): string[] {
  return lines.map((line) => {
    let out = '';
    let col = 0;
    let leading = true;
    for (const ch of line) {
      if (ch === '\t' && (leading || !leadingOnly)) {
        const n = tabSize - (col % tabSize);
        out += ' '.repeat(n);
        col += n;
      } else {
        if (ch !== ' ' && ch !== '\t') leading = false;
        out += ch;
        col += ch === '\t' ? tabSize - (col % tabSize) : 1;
      }
    }
    return out;
  });
}

/** Runs of spaces that reach a tab stop become tabs; `leadingOnly` limits it to indentation. */
export function spacesToTabs(lines: readonly string[], tabSize: number, leadingOnly = false): string[] {
  return lines.map((line) => {
    const expanded = tabsToSpaces([line], tabSize)[0]!;
    const limit = leadingOnly ? /^ */.exec(expanded)![0].length : expanded.length;
    let out = '';
    let pending = 0;
    for (let col = 0; col < expanded.length; col++) {
      const ch = expanded[col]!;
      if (ch === ' ' && col < limit) {
        pending++;
        if ((col + 1) % tabSize === 0) {
          // A lone space landing on a tab stop stays a space; it reads better and is what Notepad++ does.
          out += pending > 1 ? '\t' : ' ';
          pending = 0;
        }
      } else {
        out += ' '.repeat(pending) + ch;
        pending = 0;
      }
    }
    return out + ' '.repeat(pending);
  });
}

export type CaseMode = 'upper' | 'lower' | 'proper' | 'proper-blend' | 'sentence' | 'sentence-blend' | 'invert' | 'random';

/**
 * Convert case. "Proper" capitalises each word and lowers the rest; the
 * "blend" variants only raise the first letter and leave the rest alone (so
 * acronyms survive), as Notepad++ does. `random` takes a generator so tests can pin it.
 */
export function convertCase(text: string, mode: CaseMode, random: () => number = Math.random): string {
  switch (mode) {
    case 'upper':
      return text.toUpperCase();
    case 'lower':
      return text.toLowerCase();
    case 'proper':
      return text.toLowerCase().replace(/(^|[^\p{L}\p{N}'’])(\p{L})/gu, (_m, pre: string, c: string) => pre + c.toUpperCase());
    case 'proper-blend':
      return text.replace(/(^|[^\p{L}\p{N}'’])(\p{L})/gu, (_m, pre: string, c: string) => pre + c.toUpperCase());
    case 'sentence':
      return text.toLowerCase().replace(/(^\s*|[.!?]\s+|\n\s*)(\p{L})/gu, (_m, pre: string, c: string) => pre + c.toUpperCase());
    case 'sentence-blend':
      return text.replace(/(^\s*|[.!?]\s+|\n\s*)(\p{L})/gu, (_m, pre: string, c: string) => pre + c.toUpperCase());
    case 'invert':
      return Array.from(text, (c) => (c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase())).join('');
    case 'random':
      return Array.from(text, (c) => (random() < 0.5 ? c.toLowerCase() : c.toUpperCase())).join('');
  }
}

export type NumberFormat = 'dec' | 'hex' | 'oct' | 'bin';

export interface ColumnNumberOptions {
  readonly initial: number;
  readonly step: number;
  /** Each value is written this many times before it steps (Notepad++ "Repeat"). */
  readonly repeat?: number;
  readonly format?: NumberFormat;
  /** Pad to the widest value: 'zeros' ("007") or 'spaces' ("  7"); none leaves them ragged. */
  readonly pad?: 'none' | 'zeros' | 'spaces';
  readonly upperHex?: boolean;
}

/** The Column Editor's numbers for `count` lines. */
export function columnNumbers(count: number, options: ColumnNumberOptions): string[] {
  const repeat = Math.max(1, Math.floor(options.repeat ?? 1));
  const radix = { dec: 10, hex: 16, oct: 8, bin: 2 }[options.format ?? 'dec'];
  const values: string[] = [];
  for (let i = 0; i < count; i++) {
    const n = options.initial + Math.floor(i / repeat) * options.step;
    let s = Math.abs(n).toString(radix);
    if (options.upperHex) s = s.toUpperCase();
    values.push(n < 0 ? `-${s}` : s);
  }
  const pad = options.pad ?? 'none';
  if (pad === 'none') return values;
  const width = Math.max(...values.map((v) => v.replace('-', '').length));
  return values.map((v) => {
    const neg = v.startsWith('-');
    const digits = neg ? v.slice(1) : v;
    return pad === 'zeros' ? (neg ? '-' : '') + digits.padStart(width, '0') : v.padStart(width + (neg ? 1 : 0), ' ');
  });
}

/**
 * Insert one value per line at a column, padding short lines with spaces so
 * the values line up — what the Column Editor does across a column selection.
 * `column` counts characters (tabs are one).
 */
export function columnInsert(lines: readonly string[], column: number, values: readonly string[]): string[] {
  return lines.map((line, i) => {
    const value = values[i] ?? values[values.length - 1] ?? '';
    const padded = line.length < column ? line + ' '.repeat(column - line.length) : line;
    return padded.slice(0, column) + value + padded.slice(column);
  });
}

/** Transpose (swap) a line with the one above it; `index` is the lower line. */
export function transposeLines(lines: readonly string[], index: number): string[] {
  if (index <= 0 || index >= lines.length) return [...lines];
  const out = [...lines];
  [out[index - 1], out[index]] = [out[index]!, out[index - 1]!];
  return out;
}

/** Squeeze each run of blank lines down to one blank line. */
export function squeezeBlankLines(lines: readonly string[]): string[] {
  return lines.filter((l, i) => l.trim() !== '' || (i > 0 && lines[i - 1]!.trim() !== ''));
}
