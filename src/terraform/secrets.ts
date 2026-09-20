/**
 * Lifting variable references out of the quotes the templates put them in.
 *
 * Every blueprint template interpolates its values into quoted HCL — the line
 * is written `password = "${vals.password}"` — which is right for a name and
 * wrong for a reference. Pick `var.db_password` from the dropdown and the file
 * says `password = "var.db_password"`, which is a database whose password is
 * the literal thirteen characters `var.db_password`.
 *
 * Rather than rewrite fifteen ported templates, the fix is applied to what they
 * emit: an attribute whose entire quoted value is a bare `var.x`, `local.x` or
 * `data.a.b.c` reference is an expression, so the quotes come off. Nobody names
 * a literal string "var.db_password".
 *
 * Unquoting alone would leave a reference to a variable nothing declares, so
 * any `var.x` left undeclared gets a `variable` block appended, typed string and
 * marked `sensitive` when its name says it holds a credential. That is what
 * makes the generated file plan cleanly with `-var` or a tfvars file, instead
 * of failing on an undeclared variable.
 */

import type { Blueprint, BlueprintGroup, BuildResult } from '../kit/blueprint.ts';

/** `attr = "var.x"` — the whole value, nothing either side of the reference. */
const QUOTED_REFERENCE =
  /^(\s*[A-Za-z_][\w-]*\s*=\s*)"((?:var|local)\.[A-Za-z_][\w-]*|data\.[A-Za-z_][\w-]*(?:\.[A-Za-z_][\w-]*)+)"(\s*)$/gm;

/** `var.x` where it is an expression rather than part of some text. */
const VAR_USE = /(?<![\w.-])var\.([A-Za-z_][\w-]*)/g;

/** A comment. */
const COMMENT = /#[^\n]*|\/\/[^\n]*|\/\*[\s\S]*?\*\//g;

/** A double-quoted string, escapes and all. */
const STRING = /"(?:[^"\\]|\\.)*"/g;

/** `${ … }` inside one. */
const INTERPOLATION = /\$\{([^}]*)\}/g;

/**
 * The parts of the file that are expressions.
 *
 * `bucket = "prefix-var.bucket_name"` is a name that happens to contain the
 * letters `var.`, not a reference to anything, and declaring a variable for it
 * would be inventing one. So the quoted text is dropped before the scan —
 * except for what is inside `${ }`, where `"${var.env}-logs"` really is a
 * reference and does need declaring.
 */
function expressionsOnly(hcl: string): string {
  return hcl.replace(COMMENT, ' ').replace(STRING, (literal) => {
    const kept: string[] = [];
    for (const m of literal.matchAll(INTERPOLATION)) kept.push(m[1] ?? '');
    return kept.length === 0 ? '""' : ` ${kept.join(' ')} `;
  });
}

/** `variable "x" {` — one already declared needs no second declaration. */
const VAR_DECLARED = /^\s*variable\s+"([A-Za-z_][\w-]*)"\s*\{/gm;

/** Names that mean the value should not be printed in a plan. */
const SECRET_NAME = /password|secret|token|key$|_key$|credential|passphrase/i;

function unquote(hcl: string): string {
  return hcl.replace(QUOTED_REFERENCE, (_m, head: string, ref: string, tail: string) => `${head}${ref}${tail}`);
}

function declarations(hcl: string): string {
  const declared = new Set<string>();
  for (const m of hcl.matchAll(VAR_DECLARED)) if (m[1]) declared.add(m[1]);

  const used = new Set<string>();
  for (const m of expressionsOnly(hcl).matchAll(VAR_USE)) {
    const name = m[1];
    if (name !== undefined && !declared.has(name)) used.add(name);
  }
  if (used.size === 0) return '';

  const blocks = [...used].sort().map((name) => {
    const secret = SECRET_NAME.test(name);
    return [
      `variable "${name}" {`,
      `  type        = string`,
      `  description = "${secret ? 'Supplied at plan time; never committed.' : `Value for ${name}.`}"`,
      ...(secret ? ['  sensitive   = true'] : []),
      '}',
    ].join('\n');
  });

  const anySecret = [...used].some((name) => SECRET_NAME.test(name));
  return [
    '',
    '# Variables referenced above and not declared anywhere else. Pass them with',
    '# -var, a .tfvars file or TF_VAR_ environment variables.',
    ...(anySecret
      ? ['# A value marked sensitive is kept out of plan output but is still written',
         '# to state, so the state file needs protecting too.']
      : []),
    '',
    blocks.join('\n\n'),
    '',
  ].join('\n');
}

/** One `.tf` file, with its references lifted and anything undeclared declared. */
export function liftSecrets(hcl: string): string {
  const lifted = unquote(hcl);
  const extra = declarations(lifted);
  return extra === '' ? lifted : `${lifted.replace(/\s*$/, '\n')}${extra}`;
}

function liftResult(result: BuildResult): BuildResult {
  const files: Record<string, string> = {};
  let changed = false;
  for (const [name, contents] of Object.entries(result.files)) {
    if (!name.endsWith('.tf')) {
      files[name] = contents;
      continue;
    }
    files[name] = liftSecrets(contents);
    if (files[name] !== contents) changed = true;
  }
  return changed ? { ...result, files } : result;
}

/** Wraps a blueprint's build so everything it emits goes through the lift. */
export function withSecretLifting(blueprint: Blueprint): Blueprint {
  return { ...blueprint, build: (values, name) => liftResult(blueprint.build(values, name)) };
}

export function withSecretLiftingAll(
  groups: readonly BlueprintGroup[],
): readonly BlueprintGroup[] {
  return groups.map((group) => ({
    ...group,
    blueprints: group.blueprints.map(withSecretLifting),
  }));
}
