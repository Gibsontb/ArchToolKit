/**
 * JSON tools: format, minify, validate, sort keys, and conversion to and from
 * YAML and CSV.
 *
 * YAML goes through the toolkit's own reader (core/yaml-read.ts) and writer
 * (ansible/yaml.ts), so a value converted here reads the same way the YAML
 * editor and the Ansible kit read it — no second opinion on what `no` means.
 */

import { readYaml, YamlError, type YamlData } from '../../core/yaml-read.ts';
import { renderYaml, type YamlValue } from '../../ansible/yaml.ts';

export type JsonIndent = 2 | 4 | '\t';

/** A parse failure with where it happened, 1-based, for the status bar. */
export interface JsonProblem {
  readonly message: string;
  readonly line: number;
  readonly column: number;
}

export function lineColumnAt(text: string, offset: number): { line: number; column: number } {
  const before = text.slice(0, Math.max(0, Math.min(offset, text.length)));
  const lines = before.split('\n');
  return { line: lines.length, column: (lines[lines.length - 1]?.length ?? 0) + 1 };
}

/**
 * Where JSON.parse gave up. Engines word this differently: V8 (Chrome,
 * WebView2, Node) says "at position N" and lately "(line L column C)",
 * Firefox says "at line L column C of the JSON data". Anything else points at
 * the end, which is where an unexpected end of input is anyway.
 */
function locate(text: string, message: string): { line: number; column: number } {
  const lc = /line (\d+) column (\d+)/.exec(message);
  if (lc) return { line: Number(lc[1]), column: Number(lc[2]) };
  const pos = /position (\d+)/.exec(message);
  if (pos) return lineColumnAt(text, Number(pos[1]));
  return lineColumnAt(text, text.length);
}

/** Null when the text is valid JSON. */
export function validateJson(text: string): JsonProblem | null {
  try {
    JSON.parse(text);
    return null;
  } catch (e) {
    const raw = e instanceof Error ? e.message : String(e);
    const { line, column } = locate(text, raw);
    // The engine's own position suffix is replaced by ours, which is the same everywhere.
    const message = raw.replace(/^JSON\.parse:\s*/, '').replace(/\s*(in JSON )?at (position \d+|line \d+ column \d+).*$/, '').replace(/\s*\(line \d+ column \d+\)$/, '');
    return { message: message || 'Invalid JSON', line, column };
  }
}

/** JSON.parse with the line and column in the error message. */
export function parseJson(text: string): unknown {
  const problem = validateJson(text);
  if (problem) throw new Error(`Line ${problem.line}, column ${problem.column}: ${problem.message}`);
  return JSON.parse(text);
}

export function formatJson(text: string, indent: JsonIndent = 2): string {
  return JSON.stringify(parseJson(text), null, indent);
}

export function minifyJson(text: string): string {
  return JSON.stringify(parseJson(text));
}

/** Keys sorted at every depth; arrays keep their order, because order is their meaning. */
export function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort((a, b) => a.localeCompare(b))) out[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    return out;
  }
  return value;
}

export function sortJsonKeys(text: string, indent: JsonIndent = 2): string {
  return JSON.stringify(sortKeysDeep(parseJson(text)), null, indent);
}

export function jsonToYaml(text: string): string {
  return renderYaml(parseJson(text) as YamlValue);
}

/**
 * One document becomes one JSON value; a multi-document file (Kubernetes
 * manifests) becomes an array of them, since JSON has no document separator.
 */
export function yamlToJson(text: string, indent: JsonIndent = 2): string {
  let docs: YamlData[];
  try {
    docs = readYaml(text).documents;
  } catch (e) {
    if (e instanceof YamlError) throw e;
    throw new Error(e instanceof Error ? e.message : String(e));
  }
  const value = docs.length === 1 ? docs[0] : docs;
  return JSON.stringify(value ?? null, null, indent);
}

/** Nested objects become dotted columns (a.b.c); arrays stay JSON in their cell. */
function flatten(value: unknown, prefix: string, out: Record<string, string>): void {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const entries = Object.entries(value);
    if (entries.length === 0 && prefix) out[prefix] = '{}';
    for (const [k, v] of entries) flatten(v, prefix ? `${prefix}.${k}` : k, out);
    return;
  }
  if (!prefix) prefix = 'value';
  if (value === null || value === undefined) out[prefix] = '';
  else if (Array.isArray(value)) out[prefix] = JSON.stringify(value);
  else out[prefix] = String(value);
}

const csvCell = (text: string): string => (/["\n\r,]/.test(text) || /^\s|\s$/.test(text) ? `"${text.replace(/"/g, '""')}"` : text);

/** An array of objects as CSV; columns in first-seen order across all rows. */
export function jsonToCsv(text: string): string {
  const data = parseJson(text);
  const rows = Array.isArray(data) ? data : [data];
  if (rows.length === 0) throw new Error('The array is empty — nothing to convert.');
  const flat = rows.map((row) => {
    const out: Record<string, string> = {};
    flatten(row, '', out);
    return out;
  });
  const columns: string[] = [];
  const seen = new Set<string>();
  for (const row of flat) {
    for (const key of Object.keys(row)) {
      if (!seen.has(key)) {
        seen.add(key);
        columns.push(key);
      }
    }
  }
  const lines = [columns.map(csvCell).join(',')];
  for (const row of flat) lines.push(columns.map((c) => csvCell(row[c] ?? '')).join(','));
  return `${lines.join('\n')}\n`;
}
