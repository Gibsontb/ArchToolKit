/**
 * XML tools — format (pretty print), minify (linearize), validate — and HTML
 * entity encoding.
 *
 * Formatting works on a token stream rather than a DOM, so it keeps what a
 * DOM round trip would lose or reorder: comments, CDATA, the XML declaration,
 * a DOCTYPE, attribute quoting and order. Validation prefers the browser's
 * own parser (it knows about entities and namespaces); the tokenizer's
 * well-formedness check is the fallback where there is no DOMParser.
 */

                                                                                                        

                           
                              
                        
                                           
                         
                                                
                      
 

export class XmlError extends Error {
           line        ;
  constructor(message        , line        ) {
    super(`Line ${line}: ${message}`);
    this.line = line;
  }
}

const lineAt = (text        , offset        )         => text.slice(0, offset).split('\n').length;

/** Find the end of a tag, skipping '>' inside quoted attribute values. */
function tagEnd(src        , from        )         {
  let quote = '';
  for (let i = from; i < src.length; i += 1) {
    const c = src[i];
    if (quote) {
      if (c === quote) quote = '';
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '>') return i;
  }
  return -1;
}

export function tokenizeXml(src        )             {
  const tokens             = [];
  let i = 0;
  const until = (end        , from        , what        )         => {
    const j = src.indexOf(end, from);
    if (j < 0) throw new XmlError(`Unterminated ${what}`, lineAt(src, from));
    return j + end.length;
  };
  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt < 0) {
      tokens.push({ kind: 'text', text: src.slice(i), at: i });
      break;
    }
    if (lt > i) tokens.push({ kind: 'text', text: src.slice(i, lt), at: i });
    let end        ;
    let kind              ;
    let name                    ;
    if (src.startsWith('<!--', lt)) {
      end = until('-->', lt + 4, 'comment');
      kind = 'comment';
    } else if (src.startsWith('<![CDATA[', lt)) {
      end = until(']]>', lt + 9, 'CDATA section');
      kind = 'cdata';
    } else if (src.startsWith('<?', lt)) {
      end = until('?>', lt + 2, 'processing instruction');
      kind = 'pi';
    } else if (/^<!DOCTYPE/i.test(src.slice(lt, lt + 9))) {
      // An internal subset [ ... ] may contain '>'.
      const bracket = src.indexOf('[', lt);
      const close = src.indexOf('>', lt);
      if (bracket >= 0 && bracket < close) end = until(']', bracket, 'DOCTYPE');
      else end = lt;
      end = until('>', end, 'DOCTYPE');
      kind = 'doctype';
    } else {
      const gt = tagEnd(src, lt + 1);
      if (gt < 0) throw new XmlError('Unterminated tag', lineAt(src, lt));
      end = gt + 1;
      const inner = src.slice(lt + 1, gt);
      if (inner.startsWith('/')) {
        kind = 'close';
        name = inner.slice(1).trim();
      } else {
        kind = inner.endsWith('/') ? 'empty' : 'open';
        name = /^[^\s/>]+/.exec(inner)?.[0] ?? '';
      }
      if (!name || !/^[A-Za-z_:][\w.:-]*$/.test(name)) throw new XmlError(`Bad tag name "${name ?? ''}"`, lineAt(src, lt));
    }
    tokens.push({ kind, text: src.slice(lt, end), name, at: lt });
    i = end;
  }
  return tokens;
}

/** Tags balance and nest; one root element. Null when well formed. */
export function checkXml(src        )                  {
  let tokens            ;
  try {
    tokens = tokenizeXml(src);
  } catch (e) {
    return e instanceof XmlError ? e : new XmlError(String(e), 1);
  }
  const stack             = [];
  let roots = 0;
  for (const t of tokens) {
    if (t.kind === 'open' || t.kind === 'empty') {
      if (stack.length === 0) roots += 1;
      if (roots > 1 && stack.length === 0) return new XmlError(`Extra content: a second root element <${t.name}>`, lineAt(src, t.at));
      if (t.kind === 'open') stack.push(t);
    } else if (t.kind === 'close') {
      const top = stack.pop();
      if (!top) return new XmlError(`Closing tag </${t.name}> has no opening tag`, lineAt(src, t.at));
      if (top.name !== t.name) return new XmlError(`</${t.name}> closes <${top.name}> (opened on line ${lineAt(src, top.at)})`, lineAt(src, t.at));
    } else if (t.kind === 'text' && stack.length === 0 && t.text.trim()) {
      return new XmlError('Text outside the root element', lineAt(src, t.at));
    }
  }
  if (stack.length) {
    const top = stack[stack.length - 1] ;
    return new XmlError(`<${top.name}> is never closed`, lineAt(src, top.at));
  }
  if (roots === 0) return new XmlError('No root element', 1);
  return null;
}

/**
 * Validate with DOMParser when there is one. Chrome reports
 * "error on line 3 at column 5: ..." inside a <parsererror>; Firefox puts
 * "Line Number 3, Column 5" in it.
 */
export function validateXml(src        )                  {
  const P = (globalThis                                    ).DOMParser;
  if (!P) return checkXml(src);
  const doc = new P().parseFromString(src, 'application/xml');
  const err = doc.getElementsByTagName('parsererror')[0];
  if (!err) return null;
  const text = (err.textContent ?? '').replace(/\s+/g, ' ').trim();
  const m = /line (\d+)/i.exec(text) ?? /Line Number (\d+)/.exec(text);
  const line = m ? Number(m[1]) : (checkXml(src)?.line ?? 1);
  const detail = /error on line \d+ at column \d+: (.*?)(Below is|$)/.exec(text)?.[1]?.trim() ?? text.replace(/^XML Parsing Error:\s*/, '').split(' Location:')[0] ;
  return new XmlError(detail || 'Not well-formed', line);
}

/**
 * Pretty print. Whitespace-only text between tags is dropped and rebuilt as
 * indentation; an element holding only text stays on one line, since
 * breaking <name>value</name> apart changes the value.
 */
export function formatXml(src        , indentUnit = '  ')         {
  const tokens = tokenizeXml(src).filter((t) => !(t.kind === 'text' && !t.text.trim()));
  const out           = [];
  let depth = 0;
  const pad = ()         => indentUnit.repeat(Math.max(0, depth));
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i] ;
    const next = tokens[i + 1];
    const after = tokens[i + 2];
    if (t.kind === 'open') {
      if (next && (next.kind === 'text' || next.kind === 'cdata') && after?.kind === 'close' && after.name === t.name) {
        out.push(`${pad()}${t.text}${next.kind === 'text' ? next.text.trim() : next.text}${after.text}`);
        i += 2;
        continue;
      }
      if (next?.kind === 'close' && next.name === t.name) {
        out.push(`${pad()}${t.text}${next.text}`);
        i += 1;
        continue;
      }
      out.push(pad() + t.text);
      depth += 1;
    } else if (t.kind === 'close') {
      depth -= 1;
      out.push(pad() + t.text);
    } else if (t.kind === 'text') {
      out.push(pad() + t.text.trim());
    } else {
      out.push(pad() + t.text);
    }
  }
  return `${out.join('\n')}\n`;
}

/** Linearize: whitespace between tags goes; text content is kept as written. */
export function minifyXml(src        )         {
  return tokenizeXml(src)
    .filter((t) => !(t.kind === 'text' && !t.text.trim()))
    .map((t) => (t.kind === 'text' ? t.text.trim() : t.text))
    .join('');
}

// --- HTML entities ----------------------------------------------------------------

const NAMED                         = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', reg: '®', trade: '™',
  euro: '€', pound: '£', yen: '¥', cent: '¢', sect: '§', para: '¶', deg: '°', plusmn: '±', times: '×',
  divide: '÷', middot: '·', bull: '•', hellip: '…', ndash: '–', mdash: '—', lsquo: '‘', rsquo: '’',
  ldquo: '“', rdquo: '”', laquo: '«', raquo: '»', micro: 'µ', frac12: '½', frac14: '¼', frac34: '¾',
  iexcl: '¡', iquest: '¿', shy: '­', larr: '←', rarr: '→', uarr: '↑', darr: '↓', harr: '↔',
  le: '≤', ge: '≥', ne: '≠', infin: '∞', check: '✓', zwj: '‍', zwnj: '‌', ensp: ' ', emsp: ' ', thinsp: ' ',
  auml: 'ä', ouml: 'ö', uuml: 'ü', Auml: 'Ä', Ouml: 'Ö', Uuml: 'Ü', szlig: 'ß', eacute: 'é', egrave: 'è',
  aacute: 'á', agrave: 'à', oacute: 'ó', uacute: 'ú', iacute: 'í', ntilde: 'ñ', ccedil: 'ç', Eacute: 'É',
};

/**
 * Escape the five markup characters; with `nonAscii`, everything outside
 * ASCII as a numeric reference too (for files that must stay 7-bit).
 */
export function encodeEntities(text        , nonAscii = false)         {
  let out = text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] );
  if (nonAscii) out = out.replace(/[^\x00-\x7f]/gu, (c) => `&#x${c.codePointAt(0) .toString(16).toUpperCase()};`);
  return out;
}

export function decodeEntities(text        )         {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (whole, body        ) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return NAMED[body] ?? whole;
  });
}
