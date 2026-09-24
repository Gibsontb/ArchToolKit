/**
 * Language id -> CodeMirror language extension.
 *
 * Built lazily and cached: constructing a parser is cheap but not free, and
 * most sessions touch three or four languages out of fifty. The ids and the
 * detection rules live in lang-detect.ts; this file only knows how to load.
 */

import {
  StreamLanguage,
  LanguageSupport,
  foldService,
  javascript,
  json,
  xml,
  yaml,
  python,
  sql,
  markdown,
  html,
  css,
  cpp,
  java,
  go,
  rust,
  php,
  shell,
  powerShell,
  properties,
  toml,
  nginx,
  dockerFile,
  diff,
  ruby,
  perl,
  lua,
  csharp,
  kotlin,
  scala,
  vb,
  vbScript,
  r,
  protobuf,
  http,
  cmake,
  puppet,
  groovy,
  swift,
  erlang,
  tcl,
  fortran,
  cobol,
  pascal,
  verilog,
  vhdl,
  asn1,
} from '../vendor/archpad-editor.js';
import { ciscoMode, junosMode, iniMode, hclMode, logMode } from './modes.ts';

/** The vendor bundle ships without type declarations, so extensions are opaque here. */
type Extension = unknown;

/** Fold a line together with the more-indented lines under it (Cisco sections, Junos, YAML-ish). */
const indentFold = foldService.of((state: { doc: { lineAt(p: number): Line; line(n: number): Line; lines: number } }, from: number) => {
  const line = state.doc.lineAt(from);
  const indent = (l: Line): number => /^[ \t]*/.exec(l.text)![0].replace(/\t/g, '    ').length;
  if (!line.text.trim()) return null;
  const base = indent(line);
  let last = line;
  for (let n = line.number + 1; n <= state.doc.lines; n++) {
    const next = state.doc.line(n);
    if (!next.text.trim()) continue;
    // A Cisco "!" at the section's own level closes it.
    if (indent(next) <= base) break;
    last = next;
  }
  return last.number > line.number ? { from: line.to, to: last.to } : null;
});

/** Fold an INI/Splunk stanza from its [header] to the line before the next header. */
const stanzaFold = foldService.of((state: { doc: { lineAt(p: number): Line; line(n: number): Line; lines: number } }, from: number) => {
  const line = state.doc.lineAt(from);
  if (!/^\s*\[[^\]]+\]/.test(line.text)) return null;
  let last = line;
  for (let n = line.number + 1; n <= state.doc.lines; n++) {
    const next = state.doc.line(n);
    if (/^\s*\[[^\]]+\]/.test(next.text)) break;
    if (next.text.trim()) last = next;
  }
  return last.number > line.number ? { from: line.to, to: last.to } : null;
});

interface Line {
  readonly from: number;
  readonly to: number;
  readonly number: number;
  readonly text: string;
}

const stream = (mode: unknown, ...extra: Extension[]): Extension => {
  const lang = StreamLanguage.define(mode);
  return extra.length ? new LanguageSupport(lang, extra) : lang;
};

const LOADERS: Readonly<Record<string, () => Extension>> = {
  text: () => [],
  javascript: () => javascript({ jsx: true }),
  typescript: () => javascript({ typescript: true, jsx: true }),
  json: () => json(),
  xml: () => xml(),
  html: () => html(),
  css: () => css(),
  yaml: () => yaml(),
  python: () => python(),
  sql: () => sql(),
  markdown: () => markdown(),
  c: () => cpp(),
  cpp: () => cpp(),
  java: () => java(),
  go: () => go(),
  rust: () => rust(),
  php: () => php(),
  shell: () => stream(shell),
  powershell: () => stream(powerShell),
  properties: () => stream(properties),
  toml: () => stream(toml),
  nginx: () => stream(nginx),
  dockerfile: () => stream(dockerFile),
  diff: () => stream(diff),
  ruby: () => stream(ruby),
  perl: () => stream(perl),
  lua: () => stream(lua),
  csharp: () => stream(csharp),
  kotlin: () => stream(kotlin),
  scala: () => stream(scala),
  vb: () => stream(vb),
  vbscript: () => stream(vbScript),
  r: () => stream(r),
  protobuf: () => stream(protobuf),
  http: () => stream(http),
  cmake: () => stream(cmake),
  puppet: () => stream(puppet),
  groovy: () => stream(groovy),
  swift: () => stream(swift),
  erlang: () => stream(erlang),
  tcl: () => stream(tcl),
  fortran: () => stream(fortran),
  cobol: () => stream(cobol),
  pascal: () => stream(pascal),
  verilog: () => stream(verilog),
  vhdl: () => stream(vhdl),
  asn1: () => stream(asn1({})),
  cisco: () => stream(ciscoMode, indentFold),
  junos: () => stream(junosMode, indentFold),
  ini: () => stream(iniMode, stanzaFold),
  hcl: () => stream(hclMode, indentFold),
  log: () => stream(logMode),
};

const cache = new Map<string, Extension>();

/** The extension for a language id; unknown ids get plain text rather than an error. */
export function languageExtension(id: string): Extension {
  const hit = cache.get(id);
  if (hit) return hit;
  const loader = LOADERS[id] ?? LOADERS['text']!;
  let ext: Extension;
  try {
    ext = loader();
  } catch {
    // A broken mode should cost highlighting, never the document.
    ext = [];
  }
  cache.set(id, ext);
  return ext;
}

export function hasLanguage(id: string): boolean {
  return id in LOADERS;
}
