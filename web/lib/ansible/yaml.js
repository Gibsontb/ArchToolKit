/**
 * A small YAML writer.
 *
 * Playbooks are simple enough to emit directly, and adding a dependency to print
 * them would break the air-gapped constraint the rest of the toolkit is built
 * around.
 *
 * Quoting is where a naive YAML writer goes wrong, and the failures are quiet
 * ones — a value that parses as the wrong type rather than failing outright:
 *
 *  - `no`, `off`, `n` and `y` are booleans in YAML 1.1, which Ansible still
 *    follows. An unquoted Norwegian country code becomes `false`. So does a
 *    hostname called `no`.
 *  - `1.10` is a float, and parses as `1.1`. Version numbers lose their patch.
 *  - `0755` is octal, `1:30` is sexagesimal, and a leading `0x` is hex.
 *  - A string starting with any of `- ? : , [ ] { } # & * ! | > ' " % @ \`` is
 *    an indicator, and changes the meaning of the line.
 *
 * Every one of those is a value someone legitimately writes, so this quotes on
 * doubt rather than on a list of characters it happens to remember.
 */

                       
          
          
           
        
                        
                                                      

/** Scalars YAML 1.1 reads as booleans or null, whatever the author meant. */
const RESERVED_WORDS = new Set([
  'y', 'yes', 'n', 'no', 'true', 'false', 'on', 'off',
  'null', 'none', '~',
]);

/** Looks like a number of any YAML flavour: decimal, octal, hex, float, sexagesimal. */
const NUMERIC = /^[-+]?(0b[01_]+|0o?[0-7_]+|0x[0-9a-f_]+|[0-9_]*\.?[0-9_]+(e[-+]?[0-9]+)?|[0-9]+(:[0-5]?[0-9])+(\.[0-9]*)?)$/i;

const INDICATORS = new Set([
  '-', '?', ':', ',', '[', ']', '{', '}', '#', '&', '*', '!',
  '|', '>', "'", '"', '%', '@', '`',
]);

export function needsQuoting(value        )          {
  if (value === '') return true;
  if (value !== value.trim()) return true;
  if (RESERVED_WORDS.has(value.toLowerCase())) return true;
  if (NUMERIC.test(value)) return true;
  if (INDICATORS.has(value[0]          )) return true;
  // A colon followed by space, or a trailing colon, starts a mapping.
  if (/:\s/.test(value) || value.endsWith(':')) return true;
  // A space then # starts a comment.
  if (/\s#/.test(value)) return true;
  if (/[\n\r\t]/.test(value)) return true;
  return false;
}

/** Single-quoted, which in YAML escapes only the quote itself. */
export function quoteScalar(value        )         {
  return `'${value.replace(/'/g, "''")}'`;
}

function scalar(value                                  )         {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'null';
  if (value.includes('\n')) {
    // A block scalar keeps newlines without escaping; the trailing dash strips
    // the final newline that would otherwise be added.
    return `|-\n${value
      .split('\n')
      .map((line) => `  ${line}`)
      .join('\n')}`;
  }
  return needsQuoting(value) ? quoteScalar(value) : value;
}

function isRecord(value           )                                                 {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isScalar(value           )                                            {
  return !isRecord(value) && !Array.isArray(value);
}

function render(value           , indent        )           {
  if (isScalar(value)) {
    const text = scalar(value);
    // A block scalar is already multi-line and indented relative to its key.
    return text.startsWith('|-') ? text.split('\n') : [text];
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return ['[]'];
    const lines           = [];
    for (const item of value) {
      if (isScalar(item)) {
        lines.push(`${indent}- ${scalar(item)}`);
        continue;
      }
      const nested = render(item, `${indent}  `);
      // The first line of the item sits on the dash; the rest indent under it.
      lines.push(`${indent}- ${nested[0]?.trimStart() ?? ''}`);
      lines.push(...nested.slice(1));
    }
    return lines;
  }

  const entries = Object.entries(value).filter(([, v]) => v !== undefined)                         ;
  if (entries.length === 0) return ['{}'];

  const lines           = [];
  for (const [key, child] of entries) {
    const name = needsQuoting(key) ? quoteScalar(key) : key;
    if (isScalar(child)) {
      const text = scalar(child);
      if (text.startsWith('|-')) {
        const [head, ...rest] = text.split('\n');
        lines.push(`${indent}${name}: ${head}`);
        lines.push(...rest.map((line) => `${indent}${line}`));
      } else {
        lines.push(`${indent}${name}: ${text}`);
      }
      continue;
    }
    if (Array.isArray(child) && child.length === 0) {
      lines.push(`${indent}${name}: []`);
      continue;
    }
    if (isRecord(child) && Object.keys(child).length === 0) {
      lines.push(`${indent}${name}: {}`);
      continue;
    }
    lines.push(`${indent}${name}:`);
    // Sequences sit at the parent's indent by convention; mappings indent.
    lines.push(...render(child, Array.isArray(child) ? indent : `${indent}  `));
  }
  return lines;
}

                                      
                                                         
                           
 

/** Render one YAML document, with the `---` marker Ansible files carry. */
export function renderYaml(value           , options                      = {})         {
  const lines           = [];
  if (options.header) {
    for (const line of options.header.split('\n')) lines.push(`# ${line}`.trimEnd());
  }
  lines.push('---');
  lines.push(...render(value, ''));
  return `${lines.join('\n')}\n`;
}
