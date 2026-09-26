/**
 * A unified diff of two file sets, for the plan-managed utilities: the app
 * stack before and after a plan update (addendum A.9.1, "the bundle contains
 * that stack's diff").
 *
 * The line diff is a longest-common-subsequence walk (the stacks' files are a
 * few hundred lines, so the quadratic table is small); the output is the
 * `diff -u` format with three lines of context and no timestamps, so a bundle
 * is the same byte for byte for the same change.
 *
 * Pure: no DOM, no file system.
 */

export interface FileSetDiff {
  /** Paths only in `after`. */
  readonly added: readonly string[];
  /** Paths only in `before`. */
  readonly removed: readonly string[];
  /** Paths in both whose text differs. */
  readonly changed: readonly string[];
  /** The unified diff of every added, removed and changed file, in path order. */
  readonly text: string;
}

type Op = { readonly kind: ' ' | '-' | '+'; readonly line: string };

/** The edit script from `a` to `b`, line by line. */
export function lineOps(a: readonly string[], b: readonly string[]): Op[] {
  // Trim the common head and tail first: most edits are a few lines in a long file.
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail += 1;
  const A = a.slice(head, a.length - tail);
  const B = b.slice(head, b.length - tail);
  const n = A.length;
  const m = B.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      lcs[i]![j] = A[i] === B[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const out: Op[] = a.slice(0, head).map((line) => ({ kind: ' ', line }));
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) {
      out.push({ kind: ' ', line: A[i]! });
      i += 1;
      j += 1;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      out.push({ kind: '-', line: A[i]! });
      i += 1;
    } else {
      out.push({ kind: '+', line: B[j]! });
      j += 1;
    }
  }
  while (i < n) out.push({ kind: '-', line: A[i++]! });
  while (j < m) out.push({ kind: '+', line: B[j++]! });
  for (const line of a.slice(a.length - tail)) out.push({ kind: ' ', line });
  return out;
}

const splitLines = (text: string): string[] => {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
};

/** One file's unified diff (`--- a/<path>` / `+++ b/<path>`); '' when the texts are equal. */
export function unifiedDiff(path: string, before: string | undefined, after: string | undefined, context = 3): string {
  if (before === after) return '';
  const a = splitLines(before ?? '');
  const b = splitLines(after ?? '');
  const ops = lineOps(a, b);
  const hunks: string[] = [];
  let k = 0;
  while (k < ops.length) {
    if (ops[k]!.kind === ' ') {
      k += 1;
      continue;
    }
    // A hunk: back up `context` lines, run until `2 * context` unchanged lines in a row.
    let start = Math.max(0, k - context);
    let end = k;
    // `quiet`: the unchanged lines in a row at the end of [start, end).
    let quiet = 0;
    while (end < ops.length) {
      if (ops[end]!.kind === ' ') {
        if (quiet + 1 > context * 2) break;
        quiet += 1;
      } else {
        quiet = 0;
      }
      end += 1;
    }
    end -= Math.max(0, quiet - context);
    // Line numbers of the hunk's first line in each file.
    let aLine = 1;
    let bLine = 1;
    for (let t = 0; t < start; t += 1) {
      if (ops[t]!.kind !== '+') aLine += 1;
      if (ops[t]!.kind !== '-') bLine += 1;
    }
    const body = ops.slice(start, end);
    const aCount = body.filter((o) => o.kind !== '+').length;
    const bCount = body.filter((o) => o.kind !== '-').length;
    hunks.push(`@@ -${aCount === 0 ? aLine - 1 : aLine},${aCount} +${bCount === 0 ? bLine - 1 : bLine},${bCount} @@`);
    for (const o of body) hunks.push(`${o.kind}${o.line}`);
    k = end;
    start = end;
  }
  return [`--- ${before === undefined ? '/dev/null' : `a/${path}`}`, `+++ ${after === undefined ? '/dev/null' : `b/${path}`}`, ...hunks].join('\n') + '\n';
}

/** What changed between two file sets. */
export function diffFileSets(before: Readonly<Record<string, string>>, after: Readonly<Record<string, string>>): FileSetDiff {
  const paths = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];
  const parts: string[] = [];
  for (const p of paths) {
    const a = before[p];
    const b = after[p];
    if (a === b) continue;
    if (a === undefined) added.push(p);
    else if (b === undefined) removed.push(p);
    else changed.push(p);
    parts.push(unifiedDiff(p, a, b));
  }
  return { added, removed, changed, text: parts.join('') };
}
