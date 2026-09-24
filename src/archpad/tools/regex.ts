/**
 * The regex tester: every match with its position and groups, and the same
 * pattern used to replace. JavaScript regex syntax, which is what the
 * editor's own search uses, so a pattern tested here behaves the same there.
 */

export interface RegexMatch {
  readonly index: number;
  readonly line: number;
  readonly column: number;
  readonly text: string;
  /** Numbered groups, 1-based as $1…; undefined when a group did not take part. */
  readonly groups: readonly (string | undefined)[];
  readonly named: Readonly<Record<string, string | undefined>>;
}

/** Accept "pattern" plus flags, or a /pattern/flags literal typed whole. */
export function parsePattern(pattern: string, flags = ''): RegExp {
  const literal = /^\/(.*)\/([a-z]*)$/s.exec(pattern);
  const source = literal ? literal[1]! : pattern;
  let f = literal && !flags ? literal[2]! : flags;
  f = [...new Set(f.replace(/\s+/g, ''))].join('');
  try {
    return new RegExp(source, f);
  } catch (e) {
    throw new Error(e instanceof Error ? e.message.replace(/^Invalid regular expression: /, 'Invalid pattern: ') : String(e));
  }
}

/** All matches, capped so a pattern like /x*\/ on a big file cannot hang the page. */
export function findMatches(text: string, re: RegExp, limit = 5000): { matches: RegexMatch[]; truncated: boolean } {
  const global = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
  const lineStarts = [0];
  for (let i = 0; i < text.length; i += 1) if (text[i] === '\n') lineStarts.push(i + 1);
  const lineOf = (offset: number): number => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  const matches: RegexMatch[] = [];
  for (const m of text.matchAll(global)) {
    if (matches.length >= limit) return { matches, truncated: true };
    const line = lineOf(m.index);
    matches.push({
      index: m.index,
      line: line + 1,
      column: m.index - lineStarts[line]! + 1,
      text: m[0],
      groups: m.slice(1),
      named: { ...(m.groups ?? {}) },
    });
  }
  return { matches, truncated: false };
}

/** Replace with $1, $<name>, $& as String.replace understands them. Global unless the pattern says otherwise. */
export function regexReplace(text: string, re: RegExp, replacement: string): { text: string; count: number } {
  // Counted separately so String.replace keeps its own $-expansion, anchors and lookarounds intact.
  const found = findMatches(text, re, Number.MAX_SAFE_INTEGER).matches.length;
  const count = re.flags.includes('g') ? found : Math.min(found, 1);
  return { text: text.replace(re, replacement), count };
}
