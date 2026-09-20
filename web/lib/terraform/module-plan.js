/**
 * What a module call will build, worked out from the answers on the form.
 *
 * A registry page lists every resource a module can create. Which of them a
 * particular call actually creates is decided by the module's own conditions —
 * `count = var.create_eip ? 1 : 0` — so the list on the page is a menu, not an
 * answer. This evaluates those conditions against the values chosen, the same
 * way Terraform would, so Step 3 can say "this will create an instance, a
 * security group and two rules, and not an elastic IP" before anyone runs a
 * plan.
 *
 * It is deliberately a small evaluator, not an HCL implementation. It knows
 * booleans, null, comparisons, `!`, `&&`, `||`, parentheses, the ternary, and
 * how to look through `var.` and `local.`, plus the one `for` shape these
 * modules use for rule maps. Anything else — a function call, an attribute of
 * another resource — is *unknown*, and an
 * unknown condition is reported as "depends" with the condition shown, rather
 * than guessed. A confident wrong answer here would be worse than none, because
 * it is exactly the thing a reader would take on trust.
 */

import { moduleBySource,                  } from './modules.js';
import { MODULE_CATALOG_DATA } from './module-catalog-data.js';

/** A value in the evaluator. `UNKNOWN` is anything it cannot decide. */
const UNKNOWN = Symbol('unknown');
/** Something present that is not a scalar — a map, a list, a string. */
const PRESENT = Symbol('present');
/** `{}` or `[]`: present, not null, and holding nothing — so nothing is built from it. */
const EMPTY = Symbol('empty');
                                                                                               

                                                   

                                  
                                     
                           
                               
                                                                         
                             
                                                       
                           
 

// --- values ----------------------------------------------------------------

/** A default or typed value as written, turned into something to compare. */
function literal(text        )        {
  const t = text.trim();
  if (t === '') return UNKNOWN;
  if (t === 'null') return null;
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  if (/^"(?:[^"\\]|\\.)*"$/.test(t)) return t.slice(1, -1);
  if (/^(\{\s*\}|\[\s*\])$/.test(t)) return EMPTY;
  if (/^[[{]/.test(t)) return PRESENT;
  return UNKNOWN;
}

/** What the form's value means: blank keeps the module default. */
function inputValue(input             , chosen         )        {
  const typed = chosen === undefined || chosen === null ? '' : String(chosen).trim();
  if (typed === '') return literal(input.defaultExpr);
  if (typed === 'true') return true;
  if (typed === 'false') return false;
  if (input.kind === 'number' && !Number.isNaN(Number(typed))) return Number(typed);
  if (input.kind === 'string') return typed;
  // A list, map or object typed into the form is present, whatever it holds.
  return PRESENT;
}

function truthy(v       )                           {
  if (v === UNKNOWN) return UNKNOWN;
  if (typeof v === 'boolean') return v;
  return UNKNOWN;
}

// --- tokens ----------------------------------------------------------------

            
                          
                           
                          
                    

/**
 * Split a condition into tokens.
 *
 * Function calls, indexing and `for` expressions become a single opaque token:
 * their value is unknown, but the expression around them may still decide —
 * `var.create && try(...)` is false whenever `create` is.
 */
function tokenize(expr        )                 {
  const out          = [];
  let i = 0;
  while (i < expr.length) {
    const rest = expr.slice(i);
    const ws = /^\s+/.exec(rest);
    if (ws) {
      i += ws[0].length;
      continue;
    }
    const op = /^(&&|\|\||==|!=|>=|<=|[!?:()<>])/.exec(rest);
    if (op) {
      out.push({ t: 'op', v: op[0] });
      i += op[0].length;
      continue;
    }
    const str = /^"(?:[^"\\]|\\.)*"/.exec(rest);
    if (str) {
      out.push({ t: 'lit', v: str[0].slice(1, -1) });
      i += str[0].length;
      continue;
    }
    const num = /^\d+(\.\d+)?/.exec(rest);
    if (num) {
      out.push({ t: 'lit', v: Number(num[0]) });
      i += num[0].length;
      continue;
    }
    const word = /^[A-Za-z_][A-Za-z0-9_-]*(\.[A-Za-z_][A-Za-z0-9_-]*)*/.exec(rest);
    if (word) {
      i += word[0].length;
      // A call or an index swallows its brackets and becomes opaque.
      if (expr[i] === '(' || expr[i] === '[') {
        const open = expr[i]          ;
        const close = open === '(' ? ')' : ']';
        let depth = 0;
        for (; i < expr.length; i += 1) {
          if (expr[i] === open) depth += 1;
          if (expr[i] === close) {
            depth -= 1;
            if (depth === 0) {
              i += 1;
              break;
            }
          }
        }
        out.push({ t: 'opaque' });
        continue;
      }
      const w = word[0];
      if (w === 'true') out.push({ t: 'lit', v: true });
      else if (w === 'false') out.push({ t: 'lit', v: false });
      else if (w === 'null') out.push({ t: 'lit', v: null });
      else if (/^(var|local)\./.test(w)) out.push({ t: 'ref', v: w });
      else out.push({ t: 'opaque' });
      continue;
    }
    const empty = /^(\{\s*\}|\[\s*\])/.exec(rest);
    if (empty) {
      out.push({ t: 'lit', v: EMPTY });
      i += empty[0].length;
      continue;
    }
    // Braces, brackets, `for`: nothing this evaluator should pretend to read.
    if (rest[0] === '{' || rest[0] === '[') {
      out.push({ t: 'opaque' });
      const open = rest[0];
      const close = open === '{' ? '}' : ']';
      let depth = 0;
      for (; i < expr.length; i += 1) {
        if (expr[i] === open) depth += 1;
        if (expr[i] === close) {
          depth -= 1;
          if (depth === 0) {
            i += 1;
            break;
          }
        }
      }
      continue;
    }
    return null;
  }
  return out;
}

// --- evaluation ------------------------------------------------------------

                 
                                            
                                               
                                                                               
                                     
                                                       
                             
 

function evaluate(expr        , scope       )        {
  const parsed = tokenize(expr);
  if (!parsed) return UNKNOWN;
  const tokens          = parsed;
  let pos = 0;

  const peek = ()                    => tokens[pos];
  const isOp = (v        )          => {
    const t = peek();
    return t !== undefined && t.t === 'op' && t.v === v;
  };

  function primary()        {
    const t = tokens[pos++];
    if (!t) return UNKNOWN;
    if (t.t === 'lit') return t.v;
    if (t.t === 'opaque') return UNKNOWN;
    if (t.t === 'ref') {
      const [kind, name] = t.v.split('.')                    ;
      if (t.v.split('.').length > 2) return UNKNOWN;
      if (kind === 'var') {
        scope.used.add(name);
        return scope.vars.has(name) ? (scope.vars.get(name)         ) : UNKNOWN;
      }
      const body = scope.locals.get(name);
      if (body === undefined || scope.seen.has(name)) return UNKNOWN;
      return evaluate(body, { ...scope, seen: new Set([...scope.seen, name]) });
    }
    if (t.v === '(') {
      const v = ternary();
      if (isOp(')')) pos += 1;
      return v;
    }
    if (t.v === '!') {
      const v = truthy(unary());
      return v === UNKNOWN ? UNKNOWN : !v;
    }
    return UNKNOWN;
  }

  function unary()        {
    return primary();
  }

  function comparison()        {
    let left = unary();
    while (isOp('==') || isOp('!=') || isOp('>') || isOp('<') || isOp('>=') || isOp('<=')) {
      const op = (tokens[pos++]                 ).v;
      const right = unary();
      if (left === UNKNOWN || right === UNKNOWN) {
        left = UNKNOWN;
        continue;
      }
      if (op === '==' || op === '!=') {
        // PRESENT is never null, and is otherwise not comparable.
        let eq                          ;
        if (left === PRESENT || right === PRESENT || left === EMPTY || right === EMPTY) {
          eq = left === null || right === null ? false : UNKNOWN;
        } else eq = left === right;
        left = eq === UNKNOWN ? UNKNOWN : op === '==' ? eq : !eq;
        continue;
      }
      if (typeof left === 'number' && typeof right === 'number') {
        left = op === '>' ? left > right : op === '<' ? left < right : op === '>=' ? left >= right : left <= right;
      } else left = UNKNOWN;
    }
    return left;
  }

  function and()        {
    let left = comparison();
    while (isOp('&&')) {
      pos += 1;
      const right = comparison();
      const a = truthy(left);
      const b = truthy(right);
      // false decides an && whatever the other side is.
      left = a === false || b === false ? false : a === UNKNOWN || b === UNKNOWN ? UNKNOWN : true;
    }
    return left;
  }

  function or()        {
    let left = and();
    while (isOp('||')) {
      pos += 1;
      const right = and();
      const a = truthy(left);
      const b = truthy(right);
      left = a === true || b === true ? true : a === UNKNOWN || b === UNKNOWN ? UNKNOWN : false;
    }
    return left;
  }

  function ternary()        {
    const cond = or();
    if (!isOp('?')) return cond;
    pos += 1;
    const whenTrue = ternary();
    if (isOp(':')) pos += 1;
    const whenFalse = ternary();
    const c = truthy(cond);
    if (c === UNKNOWN) return UNKNOWN;
    return c ? whenTrue : whenFalse;
  }

  const result = ternary();
  return pos < tokens.length ? UNKNOWN : result;
}

/**
 * Whether a gated resource is created.
 *
 * `count` gates are `cond ? 1 : 0` in all but a handful of modules, so what
 * matters is the value of the whole expression: a positive number or a
 * collection means created, zero or an empty one means not. `for_each` over a
 * variable is created when that variable is present and not when it is null.
 */
/**
 * `{ for k, v in var.rules : k => v if local.create }` — one resource per
 * entry, and none when the collection is empty or the filter is false. Common
 * enough in these modules to be worth reading properly rather than giving up on.
 */
const FOR_EXPR = /^\{\s*for\s+[^:]+?\s+in\s+((?:var|local)\.[A-Za-z_][\w-]*)\s*:[^]*?(?:\bif\s+([^]+?))?\s*\}$/;

function statusOf(gate        , scope       )              {
  if (gate === '') return 'yes';

  const loop = FOR_EXPR.exec(gate.trim());
  if (loop) {
    const collection = evaluate(loop[1]          , scope);
    if (collection === null || collection === EMPTY) return 'no';
    const filter = loop[2] === undefined ? true : truthy(evaluate(loop[2], scope));
    if (filter === false) return 'no';
    if (collection === PRESENT && filter === true) return 'yes';
    return 'depends';
  }

  const value = evaluate(gate, scope);
  if (value === UNKNOWN) return 'depends';
  if (typeof value === 'number') return value > 0 ? 'yes' : 'no';
  if (value === PRESENT) return 'yes';
  if (value === EMPTY || value === null || value === false) return 'no';
  if (value === true) return 'yes';
  return 'depends';
}

/** The inputs a condition turned on, named the way the form names them. */
function because(status             , used                     , vars                            )         {
  const shown = [...used]
    .filter((name) => name !== 'create' && name !== 'putin_khuylo')
    .map((name) => {
      const v = vars.get(name);
      const text =
        v === PRESENT ? 'set' : v === EMPTY ? 'empty' : v === null ? 'not set' : v === UNKNOWN || v === undefined ? '?' : String(v);
      return `${name} = ${text}`;
    });
  if (status === 'yes' && shown.length === 0) return 'Always, when the module runs';
  if (shown.length === 0) return status === 'depends' ? 'Decided by something outside the inputs' : '';
  return shown.join(', ');
}

/**
 * Every resource the module declares, and whether this call creates it.
 *
 * Data sources are included because a registry page lists them too, and a
 * reader comparing the two should find the same rows.
 */
export function planModule(
  source        ,
  chosen                                   ,
)                             {
  const module = moduleBySource(source);
  const raw = MODULE_CATALOG_DATA.find((m) => m.source === source);
  if (!module || !raw) return [];

  const vars = new Map               ();
  for (const input of module.inputs) vars.set(input.name, inputValue(input, chosen[input.name]));
  const locals = new Map                (raw.locals.map(([n, e]) => [n, e]));

  return raw.resources.map(([kind, address, gate]) => {
    const used = new Set        ();
    const status = statusOf(gate, { vars, locals, seen: new Set(), used });
    return {
      kind: kind === 'data' ? 'data' : 'resource',
      address,
      status,
      condition: gate,
      because: because(status, used, vars),
    };
  });
}
