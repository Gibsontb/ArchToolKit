/**
 * A very small HCL writer.
 *
 * Terraform configuration is simple enough to emit directly — blocks, labels,
 * attributes and lists — and adding a dependency to print it would break the
 * air-gapped constraint the rest of the toolkit is built around.
 *
 * Only what is needed to write a resource is here. It is not a parser and not a
 * general formatter; it produces the canonical shape `terraform fmt` would leave
 * alone, which is enough for output a person reads and commits.
 */

                      
                                                       
                                                       
                                                      
                                                                  
                                                                                  
                                                     

export const str = (value        )           => ({ kind: 'string', value });
export const num = (value        )           => ({ kind: 'number', value });
export const bool = (value         )           => ({ kind: 'bool', value });
export const list = (value                     )           => ({ kind: 'list', value });
export const raw = (value        )           => ({ kind: 'raw', value });
export const strings = (values                   )           => list(values.map(str));

                               
                        
                           
 

                           
                        
                                      
                                                
                                        
                                           
                            
 

/**
 * Quote a string the way HCL expects.
 *
 * `${` has to be escaped as `$${`, or Terraform reads it as interpolation and
 * fails on a value that merely happens to contain it — a password, most likely.
 */
export function quote(value        )         {
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')
    // A replacement string treats `$$` as a literal `$`, so these use functions:
    // writing '$${' here would emit `${` and reintroduce the interpolation.
    .replace(/\$\{/g, () => '$${')
    .replace(/%\{/g, () => '%%{');
  return `"${escaped}"`;
}

function renderValue(value          , indent        )         {
  switch (value.kind) {
    case 'string':
      return quote(value.value);
    case 'number':
      return String(value.value);
    case 'bool':
      return value.value ? 'true' : 'false';
    case 'raw':
      return value.value;
    case 'list': {
      if (value.value.length === 0) return '[]';
      const simple = value.value.every((v) => v.kind !== 'list');
      const rendered = value.value.map((v) => renderValue(v, `${indent}  `));
      // Keep short lists of scalars on one line; that is what fmt does.
      const oneLine = `[${rendered.join(', ')}]`;
      if (simple && oneLine.length + indent.length <= 78) return oneLine;
      return `[\n${rendered.map((r) => `${indent}  ${r},`).join('\n')}\n${indent}]`;
    }
    default:
      return 'null';
  }
}

function pad(name        , width        )         {
  return name.padEnd(width);
}

export function renderBlock(block          , indent = '')         {
  const lines           = [];
  if (block.comment) {
    for (const line of block.comment.split('\n')) lines.push(`${indent}# ${line}`.trimEnd());
  }

  const labels = (block.labels ?? []).map((l) => `${quote(l)} `).join('');
  lines.push(`${indent}${block.type} ${labels}{`);

  const inner = `${indent}  `;
  const attributes = block.attributes ?? [];
  // Terraform aligns the `=` of consecutive attributes within a block.
  const width = attributes.reduce((w, a) => Math.max(w, a.name.length), 0);
  for (const attribute of attributes) {
    lines.push(`${inner}${pad(attribute.name, width)} = ${renderValue(attribute.value, inner)}`);
  }

  const nested = block.blocks ?? [];
  if (attributes.length > 0 && nested.length > 0) lines.push('');
  nested.forEach((child, i) => {
    lines.push(renderBlock(child, inner));
    if (i < nested.length - 1) lines.push('');
  });

  lines.push(`${indent}}`);
  return lines.join('\n');
}

/** Render a whole file: blocks separated by a blank line, trailing newline. */
export function renderFile(blocks                     , header         )         {
  const parts           = [];
  if (header) {
    parts.push(
      header
        .split('\n')
        .map((l) => `# ${l}`.trimEnd())
        .join('\n'),
    );
  }
  for (const block of blocks) parts.push(renderBlock(block));
  return `${parts.join('\n\n')}\n`;
}
