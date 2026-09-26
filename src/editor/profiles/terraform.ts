/**
 * Terraform in JSON syntax (*.tf.json) and variable files (*.tfvars.json, or
 * YAML the pipeline turns into one).
 *
 * The resource and data-source types are checked against the provider
 * catalog the Terraform kit already carries (npm run catalog:update), for the
 * providers it covers: vcf, vsphere, aws, azurerm, google, oci. A variable
 * whose name says it holds a secret should be marked sensitive, or its value
 * lands in plan output and logs.
 *
 * Each resource block is then checked against its provider's schema, the one
 * the Terraform page builds its forms from (terraform/schema-blueprints.ts):
 * the VMware providers, the Linux and Windows ones, and the four clouds.
 * Unknown arguments and blocks, missing required ones, a value of the wrong
 * type or outside the documented values, and a nested block given more or
 * fewer times than the schema allows. A value holding an expression (`${...}`)
 * is not checked: what it becomes is known only at plan time. The clouds'
 * schemas are fetched a file at a time; `prepare` fetches what a document's
 * resource types need.
 *
 * Data sources are checked by type name only: the schemas carry resources.
 */

import { classifyType, catalogueFor, dataSourceTypes, nearestTypes, resourceTypes } from '../../terraform/catalog.ts';
import type { CloudTarget } from '../../terraform/providers.ts';
import { loadResource, providerOf, resourceSchema, VMWARE_PROVIDERS } from '../../terraform/schema-blueprints.ts';
import { error, info, warning, type Finding } from '../../core/findings.ts';
import { isSecretPath, pathString, secretPaths, type Json, type Path } from '../doc.ts';
import { didYouMean, isObj, keysOf, last, str, type Profile } from '../profile.ts';

const SOURCE = 'Terraform JSON configuration syntax (developer.hashicorp.com/terraform/language/syntax/json)';

const TOP_LEVEL = new Set(['terraform', 'provider', 'variable', 'output', 'locals', 'module', 'resource', 'data', 'moved', 'import', 'check', 'removed', '//']);

const PREFIXES: readonly [string, CloudTarget][] = [
  ['azurerm_', 'azure'],
  ['google_', 'google'],
  ['aws_', 'aws'],
  ['oci_', 'oci'],
  ['vsphere_', 'vsphere'],
  ['vcf_', 'vcf'],
];

function targetOf(type: string): CloudTarget | undefined {
  return PREFIXES.find(([p]) => type.startsWith(p))?.[1];
}

/** `resource` as an object, or as the list of objects the JSON syntax also allows. */
function blocks(value: Json | undefined): Record<string, Json>[] {
  if (Array.isArray(value)) return value.filter(isObj);
  return isObj(value) ? [value] : [];
}

function checkTypes(block: 'resource' | 'data', value: Json | undefined, out: Finding[]): void {
  blocks(value).forEach((group, gi) => {
    const prefix: (string | number)[] = Array.isArray(value) ? [block, gi] : [block];
    for (const [type, instances] of Object.entries(group)) {
      const path = pathString([...prefix, type]);
      const target = targetOf(type);
      if (!isObj(instances) && !Array.isArray(instances)) {
        out.push(error('tf.block.shape', `${block} "${type}" must map names to configuration.`, { path, source: SOURCE }));
        continue;
      }
      if (!target) continue;
      const kind = classifyType(target, type);
      const entry = catalogueFor(target);
      const where = entry ? `${entry.version}` : '';
      if (kind === 'uncatalogued') {
        out.push(info('tf.type.uncatalogued', `The ${target} provider is not in the toolkit’s catalog, so ${type} could not be checked.`, { path }));
      } else if (kind === 'unknown') {
        // Word overlap finds a renamed resource; edit distance finds a typo.
        const typo = didYouMean(type, block === 'data' ? dataSourceTypes(target) : resourceTypes(target));
        const near = typo ? [typo] : nearestTypes(target, type);
        out.push(
          error('tf.type.unknown', `${type} is not a resource or data source in the ${target} provider ${where}.${near.length ? ` Did you mean ${near.join(' or ')}?` : ''}`, {
            path,
            source: entry?.source,
          }),
        );
      } else if (block === 'resource' && kind === 'data-source') {
        out.push(error('tf.type.data-as-resource', `${type} is a data source, not a resource; it belongs under data.`, { path, source: entry?.source }));
      } else if (block === 'data' && kind === 'resource') {
        // Many types are both; only a type that is a resource and not a data source is wrong here.
        const isData = entry?.dataSources.includes(type.replace(/^[a-z]+_/, ''));
        if (entry && !isData) out.push(error('tf.type.resource-as-data', `${type} is a resource, not a data source.`, { path, source: entry.source }));
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Arguments and nested blocks, against the provider schema
// ---------------------------------------------------------------------------

/** [name, type, flags, description, allowedValues?]; see schema-blueprints.ts. */
type AttrRow = readonly [string, string, string, string, (readonly string[])?];
/** [name, mode, minItems, maxItems (0 unlimited), block] */
type BlockRow = readonly [string, 1 | 'l' | 's', number, number, SchemaBlock];
interface SchemaBlock {
  readonly a: readonly AttrRow[];
  readonly b?: readonly BlockRow[];
}

/** The providers schema-blueprints.ts has schemas for. */
const SCHEMA_PROVIDERS = new Set<string>([
  ...VMWARE_PROVIDERS,
  ...['ad', 'dns', 'tls', 'cloudinit', 'ansible', 'local', 'random', 'null'],
  ...['aws', 'azurerm', 'google', 'oci'],
]);

const SCHEMA_SOURCE = 'The provider’s schema (terraform providers schema -json), as the toolkit’s Terraform kit reads it';

/** Keys every resource block takes, whatever its type. */
const META_ARGUMENTS = new Set(['count', 'for_each', 'provider', 'depends_on', 'lifecycle', 'provisioner', 'connection']);

function schemaOf(type: string): SchemaBlock | undefined {
  if (!SCHEMA_PROVIDERS.has(providerOf(type))) return undefined;
  try {
    return resourceSchema(type) as SchemaBlock | undefined;
  } catch {
    // A schema file that cannot be read leaves only the type-name check.
    return undefined;
  }
}

/** A value decided at plan time: an interpolation or a template directive. */
function isTfExpression(value: Json | undefined): boolean {
  return typeof value === 'string' && (value.includes('${') || value.includes('%{'));
}

const TYPE_WORD: Readonly<Record<string, string>> = {
  s: 'a string',
  n: 'a number',
  b: 'true or false',
  ls: 'a list of strings',
  ss: 'a set of strings',
  ln: 'a list of numbers',
  sn: 'a set of numbers',
  m: 'a map of strings',
};

/** A literal Terraform can convert to the primitive type `t`. */
function fits(t: 's' | 'n' | 'b', v: Json): boolean {
  if (v === null || isTfExpression(v)) return true;
  // Terraform converts between the primitives where the text allows it: "5" is a number.
  if (t === 's') return typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
  if (t === 'n') return typeof v === 'number' || (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)));
  return typeof v === 'boolean' || v === 'true' || v === 'false';
}

/** Whether a literal is of (or converts to) the argument's type. */
function typeFits(type: string, value: Json): boolean {
  if (value === null || isTfExpression(value)) return true;
  switch (type) {
    case 's':
    case 'n':
    case 'b':
      return fits(type, value);
    case 'ls':
    case 'ss':
    case 'ln':
    case 'sn':
      return Array.isArray(value) && value.every((v) => fits(type.endsWith('n') ? 'n' : 's', v));
    case 'm':
      return isObj(value) && Object.values(value).every((v) => fits('s', v));
    default:
      // x: an object or tuple type; h: nested blocks written whole. Not checked.
      return true;
  }
}

/** A nested block's entries: one object, or a list of them. */
function entries(value: Json): Json[] {
  return Array.isArray(value) ? value : [value];
}

function unknownArgument(type: string, name: string, at: (string | number)[], names: Iterable<string>): Finding {
  const guess = didYouMean(name, names);
  return error('tf.argument.unknown', `${type} has no argument or block called ${name} here.${guess ? ` Did you mean ${guess}?` : ''}`, {
    path: pathString(at),
    source: SCHEMA_SOURCE,
    remediation: guess
      ? `Rename it ${guess}.`
      : 'Computed-only and deprecated arguments are not in the schema the toolkit carries: the first cannot be set, the second should move to its replacement.',
  });
}

function checkValues(name: string, value: Json, values: readonly string[], at: (string | number)[], out: Finding[]): void {
  const given = Array.isArray(value) ? value.map((v, i) => [v, [...at, i]] as const) : [[value, at] as const];
  for (const [v, p] of given) {
    if (typeof v !== 'string' || v === '' || isTfExpression(v) || values.includes(v)) continue;
    // The values come from the documentation, which can lag the provider: a warning.
    out.push(
      warning('tf.argument.value', `${name} is "${v}", not one of the documented values: ${values.join(', ')}.`, {
        path: pathString(p),
        source: SCHEMA_SOURCE,
      }),
    );
  }
}

function checkBlock(type: string, block: SchemaBlock, config: Record<string, Json>, path: (string | number)[], top: boolean, out: Finding[]): void {
  const attrs = new Map(block.a.map((row) => [row[0], row]));
  const nestedBlocks = new Map((block.b ?? []).map((row) => [row[0], row]));
  const names = [...attrs.keys(), ...nestedBlocks.keys()];
  // `dynamic` generates blocks: how many is known only at plan time.
  const dynamic = isObj(config.dynamic) ? config.dynamic : {};
  for (const [name, value] of Object.entries(config)) {
    const at = [...path, name];
    if (name === '//' || (top && META_ARGUMENTS.has(name))) continue;
    if (name === 'dynamic') {
      for (const [inner, spec] of Object.entries(dynamic)) {
        const row = nestedBlocks.get(inner);
        if (!row) {
          out.push(unknownArgument(type, inner, [...at, inner], nestedBlocks.keys()));
          continue;
        }
        entries(spec).forEach((d, i) => {
          if (isObj(d) && isObj(d.content)) checkBlock(type, row[4], d.content, [...at, inner, ...(Array.isArray(spec) ? [i] : []), 'content'], false, out);
        });
      }
      continue;
    }
    const attr = attrs.get(name);
    const nested = nestedBlocks.get(name);
    if (attr) {
      const [, t, , , values] = attr;
      if (!typeFits(t, value)) {
        out.push(error('tf.argument.type', `${name} should be ${TYPE_WORD[t] ?? t}, not ${JSON.stringify(value)}.`, { path: pathString(at), source: SCHEMA_SOURCE }));
      } else if (values && values.length > 0) {
        checkValues(name, value, values, at, out);
      }
    } else if (nested) {
      const [, mode, min, max, child] = nested;
      if (value === null || isTfExpression(value)) continue;
      const list = entries(value);
      const upper = mode === 1 ? 1 : max;
      if (!(name in dynamic) && (list.length < min || (upper > 0 && list.length > upper))) {
        const want = upper === min ? `exactly ${min}` : upper > 0 ? `${min} to ${upper}` : `at least ${min}`;
        out.push(
          error('tf.block.count', `${type} takes ${want} ${name} block${upper === 1 ? '' : 's'} here; this has ${list.length}.`, {
            path: pathString(at),
            source: SCHEMA_SOURCE,
          }),
        );
      }
      list.forEach((entry, i) => {
        const p = Array.isArray(value) ? [...at, i] : at;
        if (isTfExpression(entry)) return;
        if (!isObj(entry)) {
          out.push(error('tf.block.shape', `${name} is a block: an object of its arguments.`, { path: pathString(p), source: SCHEMA_SOURCE }));
          return;
        }
        checkBlock(type, child, entry, p, false, out);
      });
    } else if (!(top && name === 'id')) {
      // `id` is in every SDK resource's schema, optional and computed; it is not in the compact one.
      out.push(unknownArgument(type, name, at, names));
    }
  }
  const where = top ? '' : ` in ${String(path.filter((p) => typeof p === 'string').pop())}`;
  for (const [name, , flags] of block.a) {
    if (flags.startsWith('r') && (config[name] === undefined || config[name] === null)) {
      out.push(error('tf.argument.required', `${type} requires ${name}${where}.`, { path: pathString(path), source: SCHEMA_SOURCE }));
    }
  }
  for (const [name, , min] of block.b ?? []) {
    if (min > 0 && config[name] === undefined && !(name in dynamic)) {
      out.push(error('tf.block.required', `${type} requires ${min === 1 ? 'a' : `at least ${min}`} ${name} block${min === 1 ? '' : 's'}${where}.`, { path: pathString(path), source: SCHEMA_SOURCE }));
    }
  }
}

interface ResourceBody {
  readonly type: string;
  readonly config: Record<string, Json>;
  readonly path: (string | number)[];
}

/** Every resource body in the document, with its type and path. */
function resourceBodies(doc: Json): ResourceBody[] {
  const out: ResourceBody[] = [];
  if (!isObj(doc)) return out;
  const value = doc.resource;
  blocks(value).forEach((group, gi) => {
    const prefix: (string | number)[] = Array.isArray(value) ? ['resource', gi] : ['resource'];
    for (const [type, instances] of Object.entries(group)) {
      if (!isObj(instances)) continue;
      for (const [name, body] of Object.entries(instances)) {
        // One object per name, or (the JSON syntax allows it) a list of them.
        if (Array.isArray(body)) body.forEach((b, i) => isObj(b) && out.push({ type, config: b, path: [...prefix, type, name, i] }));
        else if (isObj(body)) out.push({ type, config: body, path: [...prefix, type, name] });
      }
    }
  });
  return out;
}

function checkArguments(doc: Json, out: Finding[]): void {
  for (const { type, config, path } of resourceBodies(doc)) {
    const schema = schemaOf(type);
    if (schema) checkBlock(type, schema, config, path, true, out);
  }
}

/** The documented values of the argument at `path` inside a resource, when the schema has them. */
function argumentChoices(path: Path, doc: Json): readonly string[] | undefined {
  if (!isObj(doc) || path[0] !== 'resource') return undefined;
  const rest = path.slice(Array.isArray(doc.resource) ? 2 : 1);
  const type = rest[0];
  if (typeof type !== 'string') return undefined;
  let block = schemaOf(type);
  // Past the type and the resource name, and the index of a body given as a list.
  let i = typeof rest[2] === 'number' ? 3 : 2;
  while (block && i < rest.length) {
    const key = rest[i];
    if (key === 'dynamic') {
      const inner = rest[i + 1];
      block = block.b?.find((b) => b[0] === inner)?.[4];
      i += 2;
      if (typeof rest[i] === 'number') i += 1;
      if (rest[i] !== 'content') return undefined;
      i += 1;
      continue;
    }
    if (typeof key !== 'string') return undefined;
    const attr = block.a.find((a) => a[0] === key);
    if (attr) {
      const tail = rest.slice(i + 1);
      // The argument itself, or one entry of a list of strings.
      const ok = tail.length === 0 ? attr[1] === 's' : tail.length === 1 && typeof tail[0] === 'number' && (attr[1] === 'ls' || attr[1] === 'ss');
      return ok && attr[4] && attr[4].length > 0 ? attr[4] : undefined;
    }
    block = block.b?.find((b) => b[0] === key)?.[4];
    i += 1;
    if (typeof rest[i] === 'number') i += 1;
  }
  return undefined;
}

export const terraformJson: Profile = {
  id: 'terraform-json',
  family: 'terraform',
  label: 'Terraform configuration (.tf.json)',
  format: 'json',
  source: SOURCE,
  detect(doc, name) {
    if (!isObj(doc)) return 0;
    const keys = Object.keys(doc);
    if (keys.length === 0 || !keys.every((k) => TOP_LEVEL.has(k))) return 0;
    if (/\.tf\.json$/i.test(name)) return 0.99;
    return 'resource' in doc || 'data' in doc || 'provider' in doc || 'terraform' in doc ? 0.85 : 0.4;
  },
  choices(path: Path, doc: Json) {
    const argument = argumentChoices(path, doc);
    if (argument) return argument;
    const keys = keysOf(path);
    const key = last(path);
    if (keys[0] === 'variable' && key === 'type' && keys.length === 3) {
      return ['string', 'number', 'bool', 'list(string)', 'list(number)', 'set(string)', 'map(string)', 'map(number)', 'any'];
    }
    return undefined;
  },
  validate(doc) {
    const out: Finding[] = [];
    if (!isObj(doc)) return [error('tf.not-object', 'A .tf.json file is a JSON object.', { path: '' })];
    for (const key of Object.keys(doc)) {
      if (!TOP_LEVEL.has(key)) out.push(error('tf.top-level', `${key} is not a Terraform block type.`, { path: key, source: SOURCE }));
    }
    checkTypes('resource', doc.resource, out);
    checkTypes('data', doc.data, out);
    checkArguments(doc, out);
    if (isObj(doc.variable)) {
      for (const [name, v] of Object.entries(doc.variable)) {
        if (!isObj(v)) continue;
        if (isSecretPath([name]) && v.sensitive !== true) {
          out.push(
            warning('tf.variable.not-sensitive', `Variable ${name} looks like it holds a secret but is not marked sensitive, so its value shows in plan output.`, {
              path: pathString(['variable', name]),
              remediation: 'Add "sensitive": true.',
            }),
          );
        }
        if (isSecretPath([name]) && typeof v.default === 'string' && v.default !== '') {
          out.push(
            error('tf.variable.secret-default', `Variable ${name} has a secret as its default, written into the configuration.`, {
              path: pathString(['variable', name, 'default']),
              remediation: 'Remove the default and supply it from TF_VAR_ or a secret store at run time.',
            }),
          );
        }
      }
    }
    if (isObj(doc.output)) {
      for (const [name, o] of Object.entries(doc.output)) {
        if (isObj(o) && o.value === undefined) out.push(error('tf.output.no-value', `Output ${name} has no value.`, { path: pathString(['output', name]) }));
      }
    }
    if (isObj(doc.provider)) {
      for (const p of secretPaths(doc.provider)) {
        out.push(
          error('tf.provider.credential', 'A provider credential is written into the configuration.', {
            path: p.startsWith('[') ? `provider${p}` : `provider.${p}`,
            remediation: 'Take it from the environment the provider reads (for example AWS_SECRET_ACCESS_KEY, ARM_CLIENT_SECRET, VSPHERE_PASSWORD) or a variable marked sensitive.',
          }),
        );
      }
    }
    return out;
  },
  prepare(doc) {
    // An unknown type is reported by validate; there is nothing to fetch for it.
    const types = new Set(resourceBodies(doc).map((r) => r.type).filter((t) => SCHEMA_PROVIDERS.has(providerOf(t))));
    return Promise.allSettled([...types].map((t) => loadResource(t))).then(() => undefined);
  },
  itemTitle: (value) => (isObj(value) ? str(value.name) : undefined),
};

export const terraformVars: Profile = {
  id: 'terraform-vars',
  family: 'terraform',
  label: 'Terraform variable values (.tfvars.json)',
  format: 'json',
  source: 'Terraform input variables (developer.hashicorp.com/terraform/language/values/variables)',
  detect(doc, name) {
    if (!isObj(doc)) return 0;
    if (/\.tfvars\.json$/i.test(name) || /\.auto\.tfvars/i.test(name)) return 0.99;
    return 0;
  },
  validate(doc) {
    return secretPaths(doc).map((p) =>
      warning('tf.vars.secret', 'This variable file carries a secret in clear text.', {
        path: p,
        remediation: 'Keep this file out of source control, or supply the value as TF_VAR_ at run time.',
      }),
    );
  },
};
