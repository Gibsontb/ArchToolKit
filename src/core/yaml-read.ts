/**
 * A YAML reader, for the editor.
 *
 * The toolkit has written YAML since the Ansible kit; editing someone's
 * playbook, manifest or CloudFormation template means reading it too, and the
 * no-dependency rule means doing that here. This covers the YAML those files
 * are actually written in:
 *
 *  - block mappings and sequences, including a sequence at the same indent as
 *    its key (`tasks:` then `- name:` beneath it, as Ansible writes them);
 *  - plain, single- and double-quoted scalars, multi-line plain scalars, and
 *    `|` / `>` block scalars with chomping and indentation indicators;
 *  - flow collections (`[a, b]`, `{k: v}`) across lines — JSON is one;
 *  - comments, which are counted so the editor can say when a form edit
 *    would drop them;
 *  - several documents in one file (`---`), as Kubernetes manifests use;
 *  - anchors, aliases and `<<` merge keys;
 *  - tags: CloudFormation's short forms (`!Ref`, `!GetAtt`, `!Sub` …) become
 *    their long forms, which mean the same thing; `!!str` and friends coerce;
 *    any other tag (`!vault`, `!unsafe`) is reported, because rewriting the
 *    file through a form would drop it.
 *
 * Scalars follow YAML 1.1, as Ansible and most Kubernetes tooling still do:
 * `yes`/`no`/`on`/`off` are booleans. A number with a leading zero stays a
 * string, so a file mode like 0644 is not silently turned into 420.
 *
 * Every node's line is recorded against its path, so a finding about
 * `tasks[3].name` can point at line 41.
 */

export type YamlData = null | boolean | number | string | YamlData[] | { [key: string]: YamlData };

export interface YamlReadResult {
  /** One value per document. */
  readonly documents: YamlData[];
  /** Path (as `a.b[2].c`, prefixed `[n]` for document n > 0) to 1-based line. */
  readonly lines: ReadonlyMap<string, number>;
  readonly comments: number;
  /** Tags that cannot survive a round trip through a form, with their lines. */
  readonly unsupportedTags: readonly { tag: string; line: number }[];
  /** Short-form CloudFormation tags rewritten to long form. */
  readonly rewrittenTags: number;
}

/**
 * One step further down a path, written the way findings name fields:
 * `a.b[2]`. A key that is not a plain name — `ansible.builtin.copy`,
 * `Fn::GetAtt`, `$schema` is fine — goes in brackets as a JSON string
 * (`tasks[0]["ansible.builtin.copy"]`) so the path still splits back apart.
 */
export function joinPath(path: string, key: string | number): string {
  if (typeof key === 'number') return `${path}[${key}]`;
  if (/^[A-Za-z_$][\w$-]*$/.test(key)) return path ? `${path}.${key}` : key;
  return `${path}[${JSON.stringify(key)}]`;
}

export class YamlError extends Error {
  readonly line: number;
  constructor(message: string, line: number) {
    super(`Line ${line}: ${message}`);
    this.line = line;
  }
}

// ---------------------------------------------------------------------------
// Scalars
// ---------------------------------------------------------------------------

const TRUE = new Set(['true', 'True', 'TRUE', 'yes', 'Yes', 'YES', 'on', 'On', 'ON']);
const FALSE = new Set(['false', 'False', 'FALSE', 'no', 'No', 'NO', 'off', 'Off', 'OFF']);
const NULL = new Set(['', '~', 'null', 'Null', 'NULL']);

export function plainScalar(text: string): YamlData {
  const t = text.trim();
  if (NULL.has(t)) return null;
  if (TRUE.has(t)) return true;
  if (FALSE.has(t)) return false;
  if (/^[-+]?(0|[1-9][0-9_]*)$/.test(t)) return Number(t.replace(/_/g, ''));
  if (/^0x[0-9a-fA-F]+$/.test(t)) return Number.parseInt(t.slice(2), 16);
  if (/^0o[0-7]+$/.test(t)) return Number.parseInt(t.slice(2), 8);
  if (/^[-+]?([0-9][0-9_]*)?\.[0-9_]+([eE][-+]?[0-9]+)?$/.test(t) || /^[-+]?[0-9][0-9_]*[eE][-+]?[0-9]+$/.test(t)) {
    return Number(t.replace(/_/g, ''));
  }
  if (/^[-+]?\.(inf|Inf|INF)$/.test(t)) return t.startsWith('-') ? -Infinity : Infinity;
  return t;
}

function unescapeDouble(body: string, line: number): string {
  return body.replace(/\\(x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|.)/g, (_, e: string) => {
    switch (e[0]) {
      case 'n':
        return '\n';
      case 't':
        return '\t';
      case 'r':
        return '\r';
      case '0':
        return '\0';
      case '"':
        return '"';
      case '\\':
        return '\\';
      case '/':
        return '/';
      case ' ':
        return ' ';
      case 'x':
      case 'u':
      case 'U':
        return String.fromCodePoint(Number.parseInt(e.slice(1), 16));
      default:
        throw new YamlError(`unknown escape \\${e}`, line);
    }
  });
}

/** Fold the line breaks of a multi-line flow scalar: single breaks become spaces. */
function foldLines(parts: readonly string[]): string {
  // One line has no breaks to fold, and its own spaces are content.
  if (parts.length === 1) return parts[0] as string;
  let out = '';
  let blank = 0;
  parts.forEach((p, i) => {
    const s = i === 0 ? p.replace(/\s+$/, '') : i === parts.length - 1 ? p.replace(/^\s+/, '') : p.trim();
    if (s === '' && i > 0 && i < parts.length - 1) {
      blank += 1;
      return;
    }
    if (i > 0) out += blank > 0 ? '\n'.repeat(blank) : ' ';
    blank = 0;
    out += s;
  });
  return out;
}

// ---------------------------------------------------------------------------
// The reader
// ---------------------------------------------------------------------------

interface Line {
  readonly no: number;
  readonly indent: number;
  /** Content with the indent and any trailing comment removed. */
  readonly text: string;
  /** The raw line, for block scalars and quoted scalars that span lines. */
  readonly raw: string;
}

const CFN_TAGS = new Set([
  'Ref', 'Condition', 'GetAtt', 'Sub', 'Join', 'Select', 'Split', 'If', 'Equals', 'And', 'Or', 'Not',
  'FindInMap', 'Base64', 'Cidr', 'GetAZs', 'ImportValue', 'Transform', 'ToJsonString', 'Length',
]);

/** Where a comment starts in a line, outside quotes; -1 if none. */
function commentStart(line: string): number {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (quote) {
      if (c === quote) {
        if (quote === "'" && line[i + 1] === "'") i += 1;
        else quote = null;
      } else if (c === '\\' && quote === '"') i += 1;
      continue;
    }
    if (c === '"' || c === "'") {
      // Only a quote that starts a token opens a quoted scalar.
      const prev = line[i - 1];
      if (i === 0 || prev === ' ' || prev === '\t' || prev === ':' || prev === '[' || prev === '{' || prev === ',' || prev === '-') quote = c;
      continue;
    }
    if (c === '#' && (i === 0 || line[i - 1] === ' ' || line[i - 1] === '\t')) return i;
  }
  return -1;
}

/** The index of the `: ` that separates a mapping key, outside quotes and brackets; -1 if none. */
function keySeparator(text: string): number {
  let quote: string | null = null;
  let depth = 0;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quote) {
      if (c === quote) {
        if (quote === "'" && text[i + 1] === "'") i += 1;
        else quote = null;
      } else if (c === '\\' && quote === '"') i += 1;
      continue;
    }
    if ((c === '"' || c === "'") && (i === 0 || /[\s[{,]/.test(text[i - 1] as string))) {
      quote = c;
      continue;
    }
    if (c === '[' || c === '{') depth += 1;
    else if (c === ']' || c === '}') depth -= 1;
    else if (c === ':' && depth === 0 && (i + 1 === text.length || text[i + 1] === ' ' || text[i + 1] === '\t')) {
      return i;
    }
  }
  return -1;
}

export function readYaml(source: string): YamlReadResult {
  const rawLines = source.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n');
  const lines = new Map<string, number>();
  const unsupportedTags: { tag: string; line: number }[] = [];
  let comments = 0;
  let rewrittenTags = 0;

  // Split into documents, and each document into significant lines.
  const docs: Line[][] = [[]];
  let seenContent = false;
  rawLines.forEach((raw, i) => {
    const no = i + 1;
    if (/^---(\s|$)/.test(raw)) {
      if (seenContent || docs.length > 1) docs.push([]);
      seenContent = true;
      const rest = raw.slice(3).trim();
      if (rest && !rest.startsWith('#')) (docs[docs.length - 1] as Line[]).push({ no, indent: 0, text: rest, raw: rest });
      return;
    }
    if (/^\.\.\.(\s|$)/.test(raw)) return;
    if (/^%/.test(raw)) return; // directives
    const cut = commentStart(raw);
    if (cut >= 0) comments += 1;
    const body = (cut >= 0 ? raw.slice(0, cut) : raw).replace(/\s+$/, '');
    if (body.trim() === '') {
      (docs[docs.length - 1] as Line[]).push({ no, indent: -1, text: '', raw });
      return;
    }
    if (/^\t/.test(raw)) throw new YamlError('tabs cannot indent YAML', no);
    seenContent = true;
    const indent = body.length - body.trimStart().length;
    (docs[docs.length - 1] as Line[]).push({ no, indent, text: body.trim(), raw });
  });

  const documents: YamlData[] = [];
  const multi = docs.filter((d) => d.some((l) => l.indent >= 0)).length > 1;

  docs.forEach((docLines, docIndex) => {
    if (!docLines.some((l) => l.indent >= 0)) return;
    const anchors = new Map<string, YamlData>();
    let pos = 0;
    const prefix = multi ? `[${documents.length}]` : '';
    const at = (path: string, line: number) => {
      const key = path ? (prefix ? `${prefix}${path.startsWith('[') ? '' : '.'}${path}` : path) : prefix;
      if (!lines.has(key)) lines.set(key, line);
    };
    const join = joinPath;

    const skipBlank = () => {
      while (pos < docLines.length && (docLines[pos] as Line).indent < 0) pos += 1;
    };
    const peek = (): Line | undefined => {
      skipBlank();
      return docLines[pos];
    };

    /** Apply a tag to a parsed value. */
    const tagged = (tag: string, value: YamlData, line: number): YamlData => {
      if (tag === '!!str') return value === null ? '' : String(value);
      if (tag === '!!int') return Number.parseInt(String(value), 10);
      if (tag === '!!float') return Number(value);
      if (tag === '!!bool') return TRUE.has(String(value));
      if (tag === '!!null') return null;
      if (tag === '!!map' || tag === '!!seq' || tag === '!!binary' || tag === '!!timestamp') return value;
      const name = tag.slice(1);
      if (CFN_TAGS.has(name)) {
        rewrittenTags += 1;
        if (name === 'Ref' || name === 'Condition') return { [name]: value };
        if (name === 'GetAtt' && typeof value === 'string') {
          const dot = value.indexOf('.');
          return { 'Fn::GetAtt': dot > 0 ? [value.slice(0, dot), value.slice(dot + 1)] : [value] };
        }
        return { [`Fn::${name}`]: value };
      }
      unsupportedTags.push({ tag, line });
      return value;
    };

    /** Split `&anchor`, `!tag` and the rest off a scalar or node head. */
    const properties = (text: string): { anchor?: string; tag?: string; rest: string } => {
      let rest = text;
      let anchor: string | undefined;
      let tag: string | undefined;
      for (let i = 0; i < 2; i += 1) {
        const m = /^(&[^\s,[\]{}]+|![^\s,[\]{}]*)(\s+|$)/.exec(rest);
        if (!m) break;
        if ((m[1] as string).startsWith('&')) anchor = (m[1] as string).slice(1);
        else tag = m[1] as string;
        rest = rest.slice((m[0] as string).length);
      }
      return { ...(anchor ? { anchor } : {}), ...(tag ? { tag } : {}), rest };
    };

    /** Parse a flow collection or flow scalar starting in `text`, pulling more lines if brackets are open. */
    const flow = (first: string, line: number, path: string): YamlData => {
      let buf = first;
      let depth = 0;
      const count = (s: string) => {
        let q: string | null = null;
        for (let i = 0; i < s.length; i += 1) {
          const c = s[i];
          if (q) {
            if (c === q) {
              if (q === "'" && s[i + 1] === "'") i += 1;
              else q = null;
            } else if (c === '\\' && q === '"') i += 1;
          } else if (c === '"' || c === "'") q = c;
          else if (c === '[' || c === '{') depth += 1;
          else if (c === ']' || c === '}') depth -= 1;
        }
      };
      count(buf);
      while (depth > 0 && pos < docLines.length) {
        const next = docLines[pos] as Line;
        pos += 1;
        if (next.indent < 0) continue;
        buf += ` ${next.text}`;
        count(next.text);
      }
      if (depth > 0) throw new YamlError('unclosed [ or {', line);
      let i = 0;
      const ws = () => {
        while (i < buf.length && /\s/.test(buf[i] as string)) i += 1;
      };
      const value = (p: string): YamlData => {
        ws();
        const c = buf[i];
        if (c === '[') {
          i += 1;
          const arr: YamlData[] = [];
          ws();
          if (buf[i] === ']') {
            i += 1;
            return arr;
          }
          for (;;) {
            at(join(p, arr.length), line);
            arr.push(value(join(p, arr.length)));
            ws();
            if (buf[i] === ',') {
              i += 1;
              ws();
              if (buf[i] === ']') {
                i += 1;
                return arr;
              }
              continue;
            }
            if (buf[i] === ']') {
              i += 1;
              return arr;
            }
            throw new YamlError('expected , or ] in a flow sequence', line);
          }
        }
        if (c === '{') {
          i += 1;
          const obj: Record<string, YamlData> = {};
          ws();
          if (buf[i] === '}') {
            i += 1;
            return obj;
          }
          for (;;) {
            ws();
            const k = scalarToken(true);
            ws();
            let v: YamlData = null;
            const key = String(k ?? '');
            if (buf[i] === ':') {
              i += 1;
              at(join(p, key), line);
              v = value(join(p, key));
            }
            obj[key] = v;
            ws();
            if (buf[i] === ',') {
              i += 1;
              ws();
              if (buf[i] === '}') {
                i += 1;
                return obj;
              }
              continue;
            }
            if (buf[i] === '}') {
              i += 1;
              return obj;
            }
            throw new YamlError('expected , or } in a flow mapping', line);
          }
        }
        const props = /^(&[^\s,[\]{}]+|![^\s,[\]{}]*)\s+/.exec(buf.slice(i));
        if (props) {
          i += (props[0] as string).length;
          const inner = value(p);
          if ((props[1] as string).startsWith('!')) return tagged(props[1] as string, inner, line);
          anchors.set((props[1] as string).slice(1), inner);
          return inner;
        }
        if (c === '*') {
          const m = /^\*([^\s,[\]{}]+)/.exec(buf.slice(i));
          i += (m?.[0] as string).length;
          if (!anchors.has(m?.[1] as string)) throw new YamlError(`unknown alias *${m?.[1]}`, line);
          return structuredClone(anchors.get(m?.[1] as string) as YamlData);
        }
        return scalarToken(false);
      };
      const scalarToken = (asKey: boolean): YamlData => {
        const c = buf[i];
        if (c === '"') {
          let j = i + 1;
          while (j < buf.length && buf[j] !== '"') j += buf[j] === '\\' ? 2 : 1;
          const s = unescapeDouble(buf.slice(i + 1, j), line);
          i = j + 1;
          return s;
        }
        if (c === "'") {
          let j = i + 1;
          for (;;) {
            if (j >= buf.length) throw new YamlError('unclosed quote', line);
            if (buf[j] === "'") {
              if (buf[j + 1] === "'") {
                j += 2;
                continue;
              }
              break;
            }
            j += 1;
          }
          const s = buf.slice(i + 1, j).replace(/''/g, "'");
          i = j + 1;
          return s;
        }
        let j = i;
        while (j < buf.length) {
          const d = buf[j];
          if (d === ',' || d === ']' || d === '}') break;
          if (d === ':' && (asKey || /[\s,\]}]/.test(buf[j + 1] ?? ' '))) break;
          j += 1;
        }
        const s = buf.slice(i, j).trim();
        i = j;
        return asKey ? s : plainScalar(s);
      };
      const v = value(path);
      ws();
      if (i < buf.length) throw new YamlError(`unexpected text after a flow value: ${buf.slice(i, i + 20)}`, line);
      return v;
    };

    /** A block scalar (| or >) whose header is `header`, content indented beyond `parentIndent`. */
    const blockScalar = (header: string, parentIndent: number): string => {
      const m = /^([|>])([+-]?)([1-9]?)([+-]?)$/.exec(header);
      if (!m) throw new YamlError(`bad block scalar header ${header}`, (docLines[pos - 1] as Line).no);
      const folded = m[1] === '>';
      const chomp = m[2] || m[4];
      let indent = m[3] ? parentIndent + Number(m[3]) : -1;
      const content: string[] = [];
      while (pos < docLines.length) {
        const l = docLines[pos] as Line;
        const rawIndent = l.raw.length - l.raw.trimStart().length;
        if (l.raw.trim() === '') {
          content.push('');
          pos += 1;
          continue;
        }
        if (indent < 0) indent = rawIndent;
        if (rawIndent < indent || rawIndent <= parentIndent) break;
        content.push(l.raw.slice(indent));
        pos += 1;
      }
      // Trailing blank lines belong to the chomping, not the next node.
      let trailing = 0;
      while (content.length > 0 && content[content.length - 1] === '') {
        content.pop();
        trailing += 1;
      }
      let text: string;
      if (folded) {
        text = '';
        // A break between two ordinary lines folds to a space; a break into a
        // blank line folds away and each blank line is one newline; around
        // more-indented lines the breaks are kept.
        content.forEach((line, i) => {
          if (i === 0) {
            text = line;
            return;
          }
          const prev = content[i - 1] as string;
          const more = /^\s/.test(line) || /^\s/.test(prev);
          if (prev === '' || more) text += `\n${line}`;
          else if (line === '') text += '';
          else text += ` ${line}`;
        });
      } else text = content.join('\n');
      if (chomp === '-') return text;
      if (chomp === '+') return `${text}\n${'\n'.repeat(trailing)}`;
      return content.length > 0 ? `${text}\n` : '';
    };

    /** A scalar that may continue onto more-indented lines (plain or quoted). */
    const inlineScalar = (first: string, line: Line, indent: number, path: string): YamlData => {
      const props = properties(first);
      let rest = props.rest;
      let value: YamlData;
      if (rest.startsWith('*')) {
        const name = rest.slice(1).trim();
        if (!anchors.has(name)) throw new YamlError(`unknown alias *${name}`, line.no);
        value = structuredClone(anchors.get(name) as YamlData);
      } else if (rest.startsWith('[') || rest.startsWith('{')) {
        value = flow(rest, line.no, path);
      } else if (/^[|>]/.test(rest)) {
        value = blockScalar(rest, indent);
      } else if (rest.startsWith('"') || rest.startsWith("'")) {
        const q = rest[0] as string;
        const parts = [rest.slice(1)];
        const closed = (s: string): number => {
          for (let i = 0; i < s.length; i += 1) {
            if (q === '"' && s[i] === '\\') {
              i += 1;
              continue;
            }
            if (s[i] === q) {
              if (q === "'" && s[i + 1] === "'") {
                i += 1;
                continue;
              }
              return i;
            }
          }
          return -1;
        };
        let end = closed(parts[0] as string);
        while (end < 0) {
          if (pos >= docLines.length) throw new YamlError('unclosed quoted scalar', line.no);
          const next = docLines[pos] as Line;
          pos += 1;
          parts.push(next.raw);
          end = closed(next.raw);
        }
        const lastIndex = parts.length - 1;
        const tail = (parts[lastIndex] as string).slice(end + 1).trim();
        if (tail && !tail.startsWith('#')) throw new YamlError(`unexpected text after a quoted scalar: ${tail}`, line.no);
        parts[lastIndex] = (parts[lastIndex] as string).slice(0, end);
        const joined = foldLines(parts);
        value = q === '"' ? unescapeDouble(joined, line.no) : joined.replace(/''/g, "'");
      } else {
        // Plain scalar, possibly continued on more-indented lines.
        const parts = [rest];
        while (pos < docLines.length) {
          const next = docLines[pos] as Line;
          if (next.indent < 0) {
            parts.push('');
            pos += 1;
            continue;
          }
          if (next.indent <= indent || keySeparator(next.text) >= 0 || next.text.startsWith('- ')) break;
          parts.push(next.text);
          pos += 1;
        }
        while (parts.length > 1 && parts[parts.length - 1] === '') {
          parts.pop();
          pos -= 1;
          while (pos > 0 && (docLines[pos] as Line).indent >= 0 && parts.length > 0) break;
        }
        value = parts.length === 1 ? plainScalar(rest) : foldLines(parts);
        rest = '';
      }
      if (props.tag) value = tagged(props.tag, value, line.no);
      if (props.anchor) anchors.set(props.anchor, value);
      return value;
    };

    /** The node that starts at the next line, indented more than `parentIndent`. */
    const node = (parentIndent: number, path: string): YamlData => {
      const l = peek();
      if (!l || l.indent <= parentIndent) return null;
      if (l.text === '-' || l.text.startsWith('- ')) return sequence(l.indent, path);
      if (keySeparator(l.text) >= 0 || l.text.startsWith('? ')) return mapping(l.indent, path);
      pos += 1;
      at(path, l.no);
      return inlineScalar(l.text, l, parentIndent, path);
    };

    const sequence = (indent: number, path: string): YamlData[] => {
      const out: YamlData[] = [];
      for (;;) {
        const l = peek();
        if (!l || l.indent !== indent || !(l.text === '-' || l.text.startsWith('- '))) break;
        const itemPath = join(path, out.length);
        at(itemPath, l.no);
        const rest = l.text === '-' ? '' : l.text.slice(2).trimStart();
        pos += 1;
        if (rest === '') {
          out.push(node(indent, itemPath));
          continue;
        }
        // "- key: value" opens a mapping whose further keys sit at the dash's content column.
        const contentIndent = indent + (l.text.length - rest.length);
        const props = properties(rest);
        if (keySeparator(props.rest) >= 0 && !props.rest.startsWith('[') && !props.rest.startsWith('{') && !/^["']/.test(props.rest.slice(0, 1)) || (keySeparator(props.rest) >= 0 && /^["'][^"']*["']\s*:/.test(props.rest))) {
          pos -= 1;
          const synthetic: Line = { no: l.no, indent: contentIndent, text: props.rest, raw: l.raw };
          docLines[pos] = synthetic;
          const m = mapping(contentIndent, itemPath);
          if (props.anchor) anchors.set(props.anchor, m);
          out.push(props.tag ? tagged(props.tag, m, l.no) : m);
          continue;
        }
        if (props.rest === '-' || props.rest.startsWith('- ')) {
          pos -= 1;
          docLines[pos] = { no: l.no, indent: contentIndent, text: props.rest, raw: l.raw };
          out.push(sequence(contentIndent, itemPath));
          continue;
        }
        out.push(inlineScalar(rest, l, indent, itemPath));
      }
      return out;
    };

    const mapping = (indent: number, path: string): Record<string, YamlData> => {
      const out: Record<string, YamlData> = {};
      for (;;) {
        const l = peek();
        if (!l || l.indent !== indent) {
          if (l && l.indent > indent) throw new YamlError('unexpected indentation', l.no);
          break;
        }
        if (l.text === '-' || l.text.startsWith('- ')) break;
        const sep = keySeparator(l.text);
        if (sep < 0) throw new YamlError(`expected "key: value", found "${l.text.slice(0, 40)}"`, l.no);
        let keyText = l.text.slice(0, sep).trim();
        let key: string;
        if (keyText.startsWith('"')) key = unescapeDouble(keyText.slice(1, -1), l.no);
        else if (keyText.startsWith("'")) key = keyText.slice(1, -1).replace(/''/g, "'");
        else {
          const props = properties(keyText);
          keyText = props.rest;
          key = keyText;
        }
        const valueText = l.text.slice(sep + 1).trim();
        const keyPath = join(path, key);
        at(keyPath, l.no);
        pos += 1;
        let value: YamlData;
        if (valueText === '') {
          const next = peek();
          // A sequence may sit at the same indent as its key.
          if (next && next.indent === indent && (next.text === '-' || next.text.startsWith('- '))) value = sequence(indent, keyPath);
          else {
            const props = properties('');
            void props;
            value = node(indent, keyPath);
          }
        } else {
          const props = properties(valueText);
          if (props.rest === '' && (props.anchor || props.tag)) {
            const next = peek();
            let inner: YamlData;
            if (next && next.indent === indent && (next.text === '-' || next.text.startsWith('- '))) inner = sequence(indent, keyPath);
            else inner = node(indent, keyPath);
            if (props.tag) inner = tagged(props.tag, inner, l.no);
            if (props.anchor) anchors.set(props.anchor, inner);
            value = inner;
          } else value = inlineScalar(valueText, l, indent, keyPath);
        }
        if (key === '<<' && value && typeof value === 'object') {
          const sources = Array.isArray(value) ? value : [value];
          for (const src of sources) {
            if (src && typeof src === 'object' && !Array.isArray(src)) {
              for (const [k, v] of Object.entries(src)) if (!(k in out)) out[k] = v;
            }
          }
          continue;
        }
        out[key] = value;
      }
      return out;
    };

    const first = peek();
    let value: YamlData;
    if (!first) value = null;
    else if (first.text === '-' || first.text.startsWith('- ')) value = sequence(first.indent, '');
    else if (first.text.startsWith('[') || first.text.startsWith('{')) {
      pos += 1;
      value = flow(first.text, first.no, '');
    } else if (keySeparator(first.text) >= 0) value = mapping(first.indent, '');
    else {
      pos += 1;
      value = inlineScalar(first.text, first, -1, '');
    }
    const leftover = peek();
    if (leftover) throw new YamlError(`unexpected "${leftover.text.slice(0, 40)}"`, leftover.no);
    void docIndex;
    documents.push(value);
  });

  return { documents, lines, comments, unsupportedTags, rewrittenTags };
}

// ---------------------------------------------------------------------------
// JSON positions
// ---------------------------------------------------------------------------

/**
 * The line of every value in a JSON text, by path.
 *
 * JSON.parse gives the values; this gives the places, so a finding can point
 * at a line in the text view. It assumes the text parses.
 */
export function jsonLines(text: string): Map<string, number> {
  const out = new Map<string, number>();
  let i = 0;
  let line = 1;
  const ws = () => {
    while (i < text.length && /\s/.test(text[i] as string)) {
      if (text[i] === '\n') line += 1;
      i += 1;
    }
  };
  const str = (): string => {
    const start = i;
    i += 1;
    while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
    i += 1;
    return JSON.parse(text.slice(start, i)) as string;
  };
  const join = joinPath;
  const value = (path: string): void => {
    ws();
    if (!out.has(path)) out.set(path, line);
    const c = text[i];
    if (c === '{') {
      i += 1;
      ws();
      if (text[i] === '}') {
        i += 1;
        return;
      }
      for (;;) {
        ws();
        const keyLine = line;
        const key = str();
        ws();
        i += 1; // :
        out.set(join(path, key), keyLine);
        value(join(path, key));
        ws();
        if (text[i] === ',') {
          i += 1;
          continue;
        }
        i += 1; // }
        return;
      }
    }
    if (c === '[') {
      i += 1;
      ws();
      if (text[i] === ']') {
        i += 1;
        return;
      }
      for (let n = 0; ; n += 1) {
        value(join(path, n));
        ws();
        if (text[i] === ',') {
          i += 1;
          continue;
        }
        i += 1; // ]
        return;
      }
    }
    if (c === '"') {
      str();
      return;
    }
    while (i < text.length && !/[\s,\]}]/.test(text[i] as string)) i += 1;
  };
  value('');
  return out;
}
