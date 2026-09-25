/**
 * A small HCL builder for the hand-written scenarios: attribute alignment and
 * blank lines come out the way `terraform fmt` would write them, and falsy
 * items drop out, so an optional argument can be written inline.
 */

import { ident, q } from './scenario-common.js';

/** `key = value`, where value is already HCL (quote strings with q()). */
                                             
/** A nested block. */
                      
                     
                                 
 
/** Falsy items are skipped, so optional arguments can be written inline. */
                                                              

/** A block body, with `=` aligned within each run of attributes as `terraform fmt` does. */
export function render(body                 , ind        )         {
  const out           = [];
  let run         = [];
  let afterBlock = false;
  const flush = ()       => {
    if (run.length === 0) return;
    if (afterBlock) out.push('');
    const width = Math.max(...run.map((a) => a[0].length));
    for (const [k, v] of run) {
      // A long list of references reads better one per line.
      const wrap = v.length > 90 && /^\[[^"[\]]+\]$/.test(v);
      const value = wrap ? `[\n${v.slice(1, -1).split(', ').map((e) => `${ind}  ${e},`).join('\n')}\n${ind}]` : v;
      out.push(`${ind}${k.padEnd(width)} = ${value}`);
    }
    run = [];
    afterBlock = false;
  };
  for (const it of body) {
    if (!it) continue;
    if (Array.isArray(it)) {
      run.push(it        );
      continue;
    }
    flush();
    const blk = it       ;
    if (out.length > 0) out.push('');
    const inner = render(blk.body, `${ind}  `);
    out.push(inner === '' ? `${ind}${blk.b} {}` : `${ind}${blk.b} {\n${inner}\n${ind}}`);
    afterBlock = true;
  }
  flush();
  return out.join('\n');
}

export function resource(type        , name        , body                 )         {
  return `resource "${type}" "${name}" {\n${render(body, '  ')}\n}`;
}

export function data(type        , name        , body                 )         {
  return `data "${type}" "${name}" {\n${render(body, '  ')}\n}`;
}

export function output(name        , value        , description         )         {
  return `output "${name}" {\n${render([description ? ['description', q(description)] : null, ['value', value]], '  ')}\n}`;
}

export function sensitiveVariable(name        , description        )         {
  return `variable "${name}" {\n${render([['description', q(description)], ['type', 'string'], ['sensitive', 'true']], '  ')}\n}`;
}

/** `[a, b]` from expressions that are already HCL. */
export function list(values                   )         {
  return `[${values.join(', ')}]`;
}

/** `{ a = x, b = y }` over several lines, for outputs. */
export function map(entries                                        )         {
  if (entries.length === 0) return '{}';
  const width = Math.max(...entries.map(([k]) => q(k).length));
  return `{\n${entries.map(([k, v]) => `    ${q(k).padEnd(width)} = ${v}`).join('\n')}\n  }`;
}

/** A Terraform name per entry, unique within the list. */
export function uniqueIdents(names                   , fallback        )           {
  const seen = new Map                ();
  return names.map((name) => {
    const base = ident(name, fallback);
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    return count === 1 ? base : `${base}_${count}`;
  });
}
