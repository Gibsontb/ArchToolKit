/**
 * The search engine behind Find, Replace, Mark, Find All and Find in Files.
 *
 * Notepad++ has three search modes: Normal (literal), Extended (literal plus
 * \n \r \t \0 \xNN escapes) and Regular expression. All three compile to one
 * JavaScript RegExp here, so the dialog, the results panel and macros share a
 * single definition of "a match". Pure: no DOM, no editor.
 */

                                                         

                              
                         
                              
                              
                            
                                                   
                            
 

                        
                        
                      
                                                           
                                     
                                                    
 

/**
 * Turn Extended-mode escapes into characters: \n \r \t \0 \\, \xHH, \uHHHH,
 * \oOOO (octal), \dDDD (decimal) and \bBBBBBBBB (binary), as Notepad++ does.
 * An unknown escape is kept as written.
 */
export function unescapeExtended(s        )         {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i] ;
    if (c !== '\\' || i === s.length - 1) {
      out += c;
      continue;
    }
    const next = s[i + 1] ;
    const take = (len        , re        , radix        )          => {
      const digits = s.slice(i + 2, i + 2 + len);
      if (digits.length === len && re.test(digits)) {
        out += String.fromCharCode(parseInt(digits, radix));
        i += 1 + len;
        return true;
      }
      return false;
    };
    switch (next) {
      case 'n':
        out += '\n';
        i++;
        break;
      case 'r':
        out += '\r';
        i++;
        break;
      case 't':
        out += '\t';
        i++;
        break;
      case '0':
        out += '\0';
        i++;
        break;
      case '\\':
        out += '\\';
        i++;
        break;
      case 'x':
        if (!take(2, /^[0-9a-fA-F]{2}$/, 16)) out += c;
        break;
      case 'u':
        if (!take(4, /^[0-9a-fA-F]{4}$/, 16)) out += c;
        break;
      case 'o':
        if (!take(3, /^[0-7]{3}$/, 8)) out += c;
        break;
      case 'd':
        if (!take(3, /^[0-9]{3}$/, 10)) out += c;
        break;
      case 'b':
        if (!take(8, /^[01]{8}$/, 2)) out += c;
        break;
      default:
        out += c;
    }
  }
  return out;
}

export function escapeRegExp(s        )         {
  // Only syntax characters: escaping "-" or "/" is an error under the "u" flag.
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Compile the options into a global RegExp. Throws with the engine's message
 * when a regular expression is invalid, so the dialog can show it.
 */
export function buildRegExp(options             )         {
  if (!options.query) throw new Error('Nothing to search for');
  let inner        ;
  if (options.mode === 'regex') inner = options.query;
  else if (options.mode === 'extended') inner = escapeRegExp(unescapeExtended(options.query));
  else inner = escapeRegExp(options.query);
  let source = inner;
  // \b is ASCII-only in JavaScript; a look-around on letters, digits and _ treats "déjà" as one word.
  if (options.wholeWord) source = `(?<![\\p{L}\\p{N}_])(?:${source})(?![\\p{L}\\p{N}_])`;
  // "u" is needed for \p{}; it is only added when whole word asks for it, because
  // it makes some everyday regexes ("\-", "\_") invalid.
  const flags = `g${options.matchCase ? '' : 'i'}${options.mode === 'regex' ? 'm' : ''}${options.dotAll && options.mode === 'regex' ? 's' : ''}${options.wholeWord ? 'u' : ''}`;
  try {
    return new RegExp(source, flags);
  } catch (err) {
    let failure = err;
    if (options.wholeWord) {
      // Fall back to ASCII word boundaries when the pattern is invalid under "u".
      try {
        return new RegExp(`(?<![A-Za-z0-9_])(?:${inner})(?![A-Za-z0-9_])`, flags.replace('u', ''));
      } catch (again) {
        failure = again;
      }
    }
    throw new Error((failure         ).message.replace(/^Invalid regular expression: /, ''));
  }
}

function toMatch(m                 )        {
  return { from: m.index, to: m.index + m[0].length, groups: Array.from(m, (g) => g ?? ''), named: m.groups ? { ...m.groups } : undefined };
}

/** Every match in text[from, to). Zero-length matches (e.g. "^") are kept but never loop. */
export function findAll(text        , re        , from = 0, to = text.length, limit = 1_000_000)          {
  const out          = [];
  const g = re.global ? re : new RegExp(re.source, `${re.flags}g`);
  g.lastIndex = from;
  while (out.length < limit) {
    const m = g.exec(text);
    // The range is [from, to): a match must end by `to`, and an empty match exactly at `to` only counts at the end of the text.
    if (!m || m.index + m[0].length > to || (m.index === to && to !== text.length)) break;
    out.push(toMatch(m));
    if (m[0].length === 0) {
      // Step over a whole surrogate pair so an empty match cannot land between its halves.
      const code = text.charCodeAt(g.lastIndex);
      g.lastIndex += code >= 0xd800 && code <= 0xdbff ? 2 : 1;
      if (g.lastIndex > text.length) break;
    }
  }
  return out;
}

/**
 * The next match from `pos` (forward: starting at or after pos; backward:
 * ending at or before pos). With `wrap`, continue from the other end of the
 * document, as Notepad++'s "Wrap around" does.
 */
export function findFrom(text        , re        , pos        , backward         , wrap         )                                            {
  if (!backward) {
    const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
    g.lastIndex = pos;
    let m = g.exec(text);
    if (m) return { match: toMatch(m), wrapped: false };
    if (!wrap) return null;
    g.lastIndex = 0;
    m = g.exec(text);
    return m ? { match: toMatch(m), wrapped: true } : null;
  }
  const before = findAll(text, re, 0, pos).filter((m) => m.to <= pos && m.from < pos);
  if (before.length) return { match: before[before.length - 1] , wrapped: false };
  if (!wrap) return null;
  const all = findAll(text, re);
  return all.length ? { match: all[all.length - 1] , wrapped: true } : null;
}

/**
 * The replacement text for one match. Regex mode understands $1, ${1},
 * ${name}, $& / $0, \1..\9 and \n \r \t \\; Extended mode unescapes; Normal is literal.
 */
export function expandReplacement(replacement        , match       , mode            )         {
  if (mode === 'normal') return replacement;
  if (mode === 'extended') return unescapeExtended(replacement);
  let out = '';
  for (let i = 0; i < replacement.length; i++) {
    const c = replacement[i] ;
    const next = replacement[i + 1];
    if (c === '$' && next !== undefined) {
      if (next === '$') {
        out += '$';
        i++;
      } else if (next === '&') {
        out += match.groups[0] ?? '';
        i++;
      } else if (next === '{') {
        const close = replacement.indexOf('}', i + 2);
        const name = close > 0 ? replacement.slice(i + 2, close) : '';
        if (close > 0 && /^\d+$/.test(name)) {
          out += match.groups[Number(name)] ?? '';
          i = close;
        } else if (close > 0 && match.named && name in match.named) {
          out += match.named[name] ?? '';
          i = close;
        } else out += c;
      } else if (/\d/.test(next)) {
        // Two digits when that group exists ($12), otherwise one ($1 then "2").
        const two = replacement.slice(i + 1, i + 3);
        if (/^\d\d$/.test(two) && Number(two) < match.groups.length) {
          out += match.groups[Number(two)] ?? '';
          i += 2;
        } else {
          out += match.groups[Number(next)] ?? '';
          i++;
        }
      } else out += c;
    } else if (c === '\\' && next !== undefined) {
      i++;
      if (/\d/.test(next)) out += match.groups[Number(next)] ?? '';
      else if (next === 'n') out += '\n';
      else if (next === 'r') out += '\r';
      else if (next === 't') out += '\t';
      else if (next === '\\') out += '\\';
      else out += next;
    } else out += c;
  }
  return out;
}

                              
                        
                      
                          
 

/** The edits Replace All makes in text[from, to), for the editor to apply as one change. */
export function replacementsFor(text        , options             , replacement        , from = 0, to = text.length)                {
  const re = buildRegExp(options);
  return findAll(text, re, from, to).map((m) => ({ from: m.from, to: m.to, insert: expandReplacement(replacement, m, options.mode) }));
}

/** Apply replacementsFor to a string (Replace in Files and tests). */
export function replaceAllText(text        , options             , replacement        )                                  {
  const edits = replacementsFor(text, options, replacement);
  let out = '';
  let last = 0;
  for (const e of edits) {
    out += text.slice(last, e.from) + e.insert;
    last = e.to;
  }
  return { text: out + text.slice(last), count: edits.length };
}

                          
                 
                        
                            
                        
                      
                                                  
                          
 

/** Find All as the results panel wants it: each match with its line. */
export function findLines(text        , options             , limit = 20000)            {
  const re = buildRegExp(options);
  const matches = findAll(text, re, 0, text.length, limit);
  const hits            = [];
  let line = 1;
  let lineStart = 0;
  let scan = 0;
  for (const m of matches) {
    while (scan < m.from) {
      if (text.charCodeAt(scan) === 10) {
        line++;
        lineStart = scan + 1;
      }
      scan++;
    }
    let lineEnd = text.indexOf('\n', lineStart);
    if (lineEnd < 0) lineEnd = text.length;
    hits.push({ line, lineText: text.slice(lineStart, lineEnd).replace(/\r$/, ''), from: m.from, to: m.to, column: m.from - lineStart });
  }
  return hits;
}
