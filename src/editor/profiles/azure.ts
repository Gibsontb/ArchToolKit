/**
 * Azure: ARM templates, their parameter files, and Azure Policy definitions.
 *
 * ARM checks are the ones deployment validation applies first: the template
 * sections, each resource's type, apiVersion and name, parameter types, and
 * every `parameters('…')` and `variables('…')` naming something declared.
 * Policy checks are the rule grammar and the effects.
 *
 * Beyond those, each resource is checked against Microsoft's published ARM
 * schemas (../arm-schema.ts): its type must exist (with a did-you-mean), its
 * apiVersion must be one the type has, an older one is noted, and at the
 * apiVersion the schema data is for — the newest stable one — its enums,
 * required fields and the fields under `properties` are checked too.
 *
 * Bicep compiles to an ARM template, so a `bicep build` output opens here.
 */

import { error, info, warning, type Finding } from '../../core/findings.ts';
import { isSecretPath, pathString, type Json, type Path } from '../doc.ts';
import { didYouMean, isExpression, isObj, keysOf, last, str, type Profile } from '../profile.ts';
import { ARM_SCHEMA_COMMIT, ARM_SCHEMA_FETCHED, armNamespace, armType, armTypes, armTypeSchema, loadArmType, shapeOf, type ArmNode, type ArmTypeSchema } from '../arm-schema.ts';

const ARM_SOURCE = 'ARM template structure and syntax (learn.microsoft.com/azure/azure-resource-manager/templates/syntax)';
const SCHEMA_SOURCE = `Microsoft's published ARM schemas (github.com/Azure/azure-resource-manager-schemas at ${ARM_SCHEMA_COMMIT.slice(0, 7)}, fetched ${ARM_SCHEMA_FETCHED})`;
const POLICY_SOURCE = 'Azure Policy definition structure (learn.microsoft.com/azure/governance/policy/concepts/definition-structure-basics)';

export const TEMPLATE_SCHEMAS = [
  'https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#',
  'https://schema.management.azure.com/schemas/2018-05-01/subscriptionDeploymentTemplate.json#',
  'https://schema.management.azure.com/schemas/2019-08-01/managementGroupDeploymentTemplate.json#',
  'https://schema.management.azure.com/schemas/2019-08-01/tenantDeploymentTemplate.json#',
];
const PARAMETERS_SCHEMA = 'https://schema.management.azure.com/schemas/2019-04-01/deploymentParameters.json#';

const SECTIONS = new Set(['$schema', 'languageVersion', 'contentVersion', 'apiProfile', 'definitions', 'parameters', 'variables', 'functions', 'resources', 'outputs', 'metadata', 'imports', 'extensions']);
const PARAM_TYPES = ['string', 'securestring', 'int', 'bool', 'object', 'secureObject', 'array'];
const TYPE_RE = /^[A-Za-z0-9]+(\.[A-Za-z0-9]+)+\/[A-Za-z0-9]+(\/[A-Za-z0-9]+)*$/;
const API_VERSION_RE = /^\d{4}-\d{2}-\d{2}(-(preview|beta|alpha|privatepreview))?$/;

function isTemplate(doc: Json): doc is Record<string, Json> {
  if (!isObj(doc)) return false;
  const schema = str(doc.$schema) ?? '';
  if (/DeploymentTemplate\.json/i.test(schema)) return true;
  return 'contentVersion' in doc && 'resources' in doc;
}

function isParameters(doc: Json): doc is Record<string, Json> {
  return isObj(doc) && /deploymentParameters\.json/i.test(str(doc.$schema) ?? '');
}

/** Resources, whether as the usual list or languageVersion 2.0's object keyed by symbolic name. */
function resourceEntries(value: Json | undefined): [string | number, Json][] {
  if (Array.isArray(value)) return value.map((r, i) => [i, r]);
  if (isObj(value)) return Object.entries(value);
  return [];
}

/**
 * The full type of a resource: a child nested in its parent's `resources`
 * may be written short, as `subnets` under `Microsoft.Network/virtualNetworks`.
 */
function fullType(type: string, parent: string | undefined): string {
  if (!parent || type.includes('/')) return type;
  return `${parent}/${type}`;
}

/** Every resource, nested ones included, with its full type (undefined when it is an expression). */
function eachResource(list: Json | undefined, at: (string | number)[], parent: string | undefined, fn: (r: Record<string, Json>, path: (string | number)[], type: string | undefined) => void): void {
  for (const [key, r] of resourceEntries(list)) {
    if (!isObj(r)) continue;
    const path = [...at, key];
    const raw = str(r.type);
    const type = raw && !isExpression(raw) ? fullType(raw, parent) : undefined;
    fn(r, path, type);
    if ('resources' in r) eachResource(r.resources as Json, [...path, 'resources'], type, fn);
  }
}

function checkResources(list: Json | undefined, at: (string | number)[], out: Finding[]): void {
  eachResource(list, at, undefined, (r, path, full) => {
    const existing = 'existing' in r && r.existing === true;
    const type = str(r.type);
    const nested = path.length > 2;
    if (!type) {
      if (!existing) out.push(error('arm.resource.type', 'A resource needs a type.', { path: pathString(path), source: ARM_SOURCE }));
    } else if (!type.startsWith('[') && !TYPE_RE.test(type) && !(nested && CHILD_RE.test(type))) {
      out.push(error('arm.resource.type-format', `${type} is not a resource type; types are written Namespace/type, as Microsoft.Storage/storageAccounts.`, { path: pathString([...path, 'type']), source: ARM_SOURCE }));
    }
    const api = str(r.apiVersion);
    let apiOk = false;
    if (!api) {
      if (!existing) out.push(error('arm.resource.apiVersion', `${type ?? 'This resource'} has no apiVersion.`, { path: pathString(path), source: ARM_SOURCE }));
    } else if (isExpression(api)) {
      // Decided at deployment.
    } else if (!API_VERSION_RE.test(api)) {
      out.push(error('arm.resource.apiVersion-format', `${api} is not an API version; they are dates, as 2023-05-01.`, { path: pathString([...path, 'apiVersion']), source: ARM_SOURCE }));
    } else {
      apiOk = true;
      if (/-preview$/.test(api)) out.push(warning('arm.resource.preview', `${type} uses a preview API version, which can change or be withdrawn.`, { path: pathString([...path, 'apiVersion']) }));
    }
    if (!existing && !('name' in r)) out.push(error('arm.resource.name', `${type ?? 'This resource'} has no name.`, { path: pathString(path), source: ARM_SOURCE }));
    if (full && TYPE_RE.test(full)) checkAgainstSchema(r, full, apiOk ? api : undefined, path, existing, out);
  });
}

// ---------------------------------------------------------------------------
// Resource types, apiVersions and properties, from Microsoft's ARM schemas
// ---------------------------------------------------------------------------

/** A child type written short, inside its parent: `subnets`, `blobServices/containers`. */
const CHILD_RE = /^[A-Za-z0-9]+(\/[A-Za-z0-9]+)*$/;
const isStableVersion = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v);

function checkAgainstSchema(r: Record<string, Json>, type: string, api: string | undefined, path: (string | number)[], existing: boolean, out: Finding[]): void {
  const typePath = pathString([...path, 'type']);
  const known = armType(type);
  if (!known) {
    const ns = type.split('/')[0] as string;
    const inNs = armNamespace(ns);
    const guess = didYouMean(type, inNs ? armTypes(inNs) : armTypes());
    const what = inNs ? `${inNs} has no resource type ${type.slice(ns.length + 1)}` : `${ns} is not a namespace in Microsoft's ARM schemas`;
    const message = `${what}.${guess ? ` Did you mean ${guess}?` : ''}`;
    // A near miss is a typo; anything else may be a type the schemas do not publish.
    out.push((guess ? error : warning)('arm.resource.type-unknown', message, { path: typePath, source: SCHEMA_SOURCE }));
    return;
  }
  if (!api) return;
  const apiPath = pathString([...path, 'apiVersion']);
  const versions = known.versions;
  if (!versions.some((v) => v.toLowerCase() === api.toLowerCase())) {
    out.push(error('arm.resource.apiVersion-unknown', `${known.type} has no apiVersion ${api}. The newest are ${versions.slice(0, 5).join(', ')}.`, {
      path: apiPath,
      source: SCHEMA_SOURCE,
      remediation: `Use one of the ${versions.length} apiVersions ${known.type} has.`,
    }));
    return;
  }
  const date = api.slice(0, 10);
  const newer = versions.filter((v) => v.slice(0, 10) > date && (isStableVersion(v) || !isStableVersion(api)));
  if (newer.length) {
    out.push(info('arm.resource.apiVersion-old', `A newer apiVersion of ${known.type} exists: ${newer[0]}${newer.length > 1 ? ` (${newer.length} newer in all)` : ''}.`, { path: apiPath, source: SCHEMA_SOURCE }));
  }
  const schema = armTypeSchema(known.type);
  if (!schema || existing || schema.apiVersion.toLowerCase() !== api.toLowerCase()) return;
  checkBody(r, schema, path, out);
}

/**
 * Fields whose published list is known to lag the service (new VM sizes ship
 * every month, and the provider takes any): their enums are offered, not enforced.
 */
const OPEN_ENUMS = /^vmSize$/i;

/** Keys the template language owns, not the resource provider. */
const TEMPLATE_KEYS = new Set(['type', 'apiVersion', 'name', 'resources', 'dependsOn', 'comments', 'condition', 'copy', 'scope', 'existing', 'metadata', 'import']);

function field(fields: Readonly<Record<string, ArmNode>>, key: string): ArmNode | undefined {
  if (key in fields) return fields[key];
  const lower = key.toLowerCase();
  for (const [k, v] of Object.entries(fields)) if (k.toLowerCase() === lower) return v;
  return undefined;
}

function checkBody(r: Record<string, Json>, schema: ArmTypeSchema, path: (string | number)[], out: Finding[]): void {
  const top = shapeOf(schema.body, schema.defs);
  const where = `${schema.type} ${schema.apiVersion}`;
  const present = new Set(Object.keys(r).map((k) => k.toLowerCase()));
  for (const req of top.required) {
    if (!TEMPLATE_KEYS.has(req) && !present.has(req.toLowerCase())) out.push(error('arm.resource.required', `${where} needs ${req}.`, { path: pathString(path), source: SCHEMA_SOURCE }));
  }
  if (!top.fields) return;
  for (const [key, value] of Object.entries(r)) {
    if (TEMPLATE_KEYS.has(key)) continue;
    const node = field(top.fields, key);
    if (node) checkValue(value, node, [...path, key], key.toLowerCase() === 'properties', schema, where, out);
  }
}

/**
 * A value against its schema node: its enum, the required fields of an
 * object, and — under `properties`, where `strict` is set — fields the schema
 * does not have. Expressions are skipped: their value comes at deployment.
 */
function checkValue(value: Json, node: ArmNode, path: (string | number)[], strict: boolean, schema: ArmTypeSchema, where: string, out: Finding[]): void {
  if (typeof value === 'string' && isExpression(value)) return;
  const shape = shapeOf(node, schema.defs);
  const at = pathString(path);
  // A flags enum takes several of its values, comma-separated: "Logging, Metrics".
  const listed = (v: string) => shape.enum?.some((e) => e.toLowerCase() === v.trim().toLowerCase()) ?? true;
  if (typeof value === 'string' && shape.enum?.length && !OPEN_ENUMS.test(String(last(path))) && !listed(value) && !value.split(',').every(listed)) {
    const guess = didYouMean(value, shape.enum);
    const list = `${shape.enum.slice(0, 12).join(', ')}${shape.enum.length > 12 ? ', …' : ''}`;
    out.push(warning('arm.property.enum', `${value} is not one of the values ${where} lists for ${String(last(path))}: ${list}.${guess ? ` Did you mean ${guess}?` : ''}`, { path: at, source: SCHEMA_SOURCE }));
    return;
  }
  if (Array.isArray(value)) {
    const items = shape.items;
    if (items) value.forEach((v, i) => checkValue(v, items, [...path, i], strict, schema, where, out));
    return;
  }
  if (!isObj(value)) return;
  if (shape.fields) {
    // Property iteration: `"copy": [{"name": "dataDisks", "count": …, "input": …}]` makes the field.
    const copied = new Set<string>();
    if (strict && Array.isArray(value.copy)) for (const c of value.copy) if (isObj(c) && typeof c.name === 'string') copied.add(c.name.toLowerCase());
    const present = new Set(Object.keys(value).map((k) => k.toLowerCase()));
    for (const req of shape.required) {
      if (!present.has(req.toLowerCase()) && !copied.has(req.toLowerCase())) out.push(error('arm.property.required', `${where} needs ${req} here.`, { path: at, source: SCHEMA_SOURCE }));
    }
    for (const [key, v] of Object.entries(value)) {
      if (key === 'copy' && copied.size) continue;
      const f = field(shape.fields, key);
      if (f) checkValue(v, f, [...path, key], strict, schema, where, out);
      else if (strict && !shape.open) {
        const guess = didYouMean(key, Object.keys(shape.fields));
        out.push(warning('arm.property.unknown', `${where} has no field ${key} here.${guess ? ` Did you mean ${guess}?` : ''}`, {
          path: pathString([...path, key]),
          source: SCHEMA_SOURCE,
          remediation: 'Fields differ between apiVersions; check the one this resource uses.',
        }));
      }
    }
  } else if (shape.map) {
    const map = shape.map;
    for (const [key, v] of Object.entries(value)) checkValue(v, map, [...path, key], strict, schema, where, out);
  }
}

/** The resource a path is in, with its full type, and the rest of the path inside it. */
function resourceAt(doc: Json, path: Path): { r: Record<string, Json>; type: string | undefined; rest: Path } | undefined {
  if (!isObj(doc) || path[0] !== 'resources') return undefined;
  let list: Json | undefined = doc.resources;
  let parent: string | undefined;
  let i = 1;
  for (;;) {
    const key = path[i];
    if (key === undefined) return undefined;
    const r: Json | undefined = Array.isArray(list) && typeof key === 'number' ? list[key] : isObj(list) && typeof key === 'string' ? list[key] : undefined;
    if (!isObj(r)) return undefined;
    const raw = str(r.type);
    const type = raw && !isExpression(raw) ? fullType(raw, parent) : undefined;
    i += 1;
    if (path[i] === 'resources' && path.length > i + 1) {
      list = r.resources;
      parent = type;
      i += 1;
      continue;
    }
    return { r, type, rest: path.slice(i) };
  }
}

/** A resource's apiVersions, and the enum of a field, for the apiVersion the schema is for. */
function schemaChoices(doc: Json, path: Path): readonly string[] | undefined {
  const at = resourceAt(doc, path);
  if (!at?.type || !at.rest.length) return undefined;
  const known = armType(at.type);
  if (!known) return undefined;
  if (at.rest.length === 1 && at.rest[0] === 'apiVersion') return known.versions;
  const api = str(at.r.apiVersion);
  const schema = armTypeSchema(known.type);
  if (!schema || !api || schema.apiVersion.toLowerCase() !== api.toLowerCase()) return undefined;
  let node: ArmNode | undefined = schema.body;
  for (const step of at.rest) {
    if (!node) return undefined;
    const shape = shapeOf(node, schema.defs);
    if (typeof step === 'number') node = shape.items;
    else node = shape.fields ? field(shape.fields, step) : shape.map;
  }
  if (!node) return undefined;
  const e = shapeOf(node, schema.defs).enum;
  return e?.length ? e : undefined;
}

/** Fetch the schema chunks for the template's resource types, nested ones included. */
function prepareTemplate(doc: Json): Promise<void> {
  if (!isTemplate(doc)) return Promise.resolve();
  const loads: Promise<void>[] = [];
  eachResource(doc.resources as Json, ['resources'], undefined, (_r, _path, type) => {
    if (type) loads.push(loadArmType(type));
  });
  return Promise.allSettled(loads).then(() => undefined);
}

/** `[parameters('x')]` and `[variables('y')]` inside every expression string. */
function checkExpressions(doc: Record<string, Json>, out: Finding[]): void {
  const params = new Set(isObj(doc.parameters) ? Object.keys(doc.parameters) : []);
  const vars = new Set(isObj(doc.variables) ? Object.keys(doc.variables) : []);
  if (isObj(doc.variables) && Array.isArray(doc.variables.copy)) {
    for (const c of doc.variables.copy) if (isObj(c) && typeof c.name === 'string') vars.add(c.name);
  }
  const walk = (node: Json, path: (string | number)[]): void => {
    if (typeof node === 'string') {
      if (!node.startsWith('[') || node.startsWith('[[')) return;
      for (const m of node.matchAll(/\b(parameters|variables)\(\s*'([^']+)'\s*\)/g)) {
        const [, fn, name] = m as unknown as [string, string, string];
        const known = fn === 'parameters' ? params : vars;
        if (!known.has(name)) {
          const guess = didYouMean(name, known);
          out.push(error(`arm.${fn}.unknown`, `${fn}('${name}') names nothing declared under ${fn}.${guess ? ` Did you mean ${guess}?` : ''}`, { path: pathString(path), source: ARM_SOURCE }));
        }
      }
      return;
    }
    if (Array.isArray(node)) node.forEach((v, i) => walk(v, [...path, i]));
    else if (isObj(node)) for (const [k, v] of Object.entries(node)) walk(v, [...path, k]);
  };
  for (const section of ['variables', 'resources', 'outputs'] as const) if (section in doc) walk(doc[section] as Json, [section]);
}

export const azureArm: Profile = {
  id: 'azure-arm',
  family: 'azure',
  label: 'Azure Resource Manager template',
  format: 'json',
  source: ARM_SOURCE,
  detect: (doc) => (isTemplate(doc) ? 0.95 : 0),
  choices(path: Path, doc: Json) {
    const keys = keysOf(path);
    const key = last(path);
    if (keys.length === 1 && key === '$schema') return TEMPLATE_SCHEMAS;
    if ((keys[0] === 'parameters' || keys[0] === 'outputs') && keys.length === 3 && key === 'type') return PARAM_TYPES;
    if (keys[0] === 'parameters' && keys.length === 3 && key === 'defaultValue' && isObj(doc) && isObj(doc.parameters)) {
      const p = doc.parameters[keys[1] as string];
      if (isObj(p) && Array.isArray(p.allowedValues) && p.allowedValues.every((v) => typeof v === 'string')) return p.allowedValues as string[];
    }
    if (keys.length === 1 && key === 'languageVersion') return ['2.0'];
    return schemaChoices(doc, path);
  },
  prepare: prepareTemplate,
  validate(doc) {
    const out: Finding[] = [];
    if (!isTemplate(doc)) return out;
    for (const key of Object.keys(doc)) {
      if (!SECTIONS.has(key)) {
        const guess = didYouMean(key, SECTIONS);
        out.push(error('arm.section', `${key} is not a template section.${guess ? ` Did you mean ${guess}?` : ''}`, { path: pathString([key]), source: ARM_SOURCE }));
      }
    }
    const schema = str(doc.$schema);
    if (!schema) out.push(error('arm.schema', 'A template needs $schema.', { path: '', source: ARM_SOURCE }));
    if (!str(doc.contentVersion)) out.push(error('arm.contentVersion', 'A template needs contentVersion, as 1.0.0.0.', { path: '', source: ARM_SOURCE }));
    else if (!/^\d+\.\d+\.\d+\.\d+$/.test(str(doc.contentVersion) as string)) {
      out.push(error('arm.contentVersion-format', 'contentVersion is four numbers, as 1.0.0.0.', { path: 'contentVersion', source: ARM_SOURCE }));
    }
    if (isObj(doc.parameters)) {
      for (const [name, p] of Object.entries(doc.parameters)) {
        if (!isObj(p)) continue;
        const type = str(p.type);
        if (!type) out.push(error('arm.parameter.type', `Parameter ${name} has no type.`, { path: pathString(['parameters', name]), source: ARM_SOURCE }));
        else if (!PARAM_TYPES.some((t) => t.toLowerCase() === type.toLowerCase())) {
          out.push(error('arm.parameter.type-invalid', `${type} is not a parameter type.`, { path: pathString(['parameters', name, 'type']), source: ARM_SOURCE }));
        }
        const secure = type !== undefined && /^secure/i.test(type);
        if (isSecretPath([name]) && !secure) {
          out.push(warning('arm.parameter.not-secure', `Parameter ${name} looks like a secret but is ${type ?? 'untyped'}, so its value is logged with the deployment.`, { path: pathString(['parameters', name, 'type']), remediation: 'Use securestring (or secureObject).' }));
        }
        if ((secure || isSecretPath([name])) && typeof p.defaultValue === 'string' && p.defaultValue !== '' && !p.defaultValue.startsWith('[')) {
          out.push(error('arm.parameter.secret-default', `Parameter ${name} has a secret as its default, written into the template.`, { path: pathString(['parameters', name, 'defaultValue']) }));
        }
        if (Array.isArray(p.allowedValues) && p.defaultValue !== undefined && !p.allowedValues.some((v) => JSON.stringify(v) === JSON.stringify(p.defaultValue))) {
          out.push(error('arm.parameter.default', `The default for ${name} is not one of its allowedValues.`, { path: pathString(['parameters', name, 'defaultValue']), source: ARM_SOURCE }));
        }
      }
    }
    checkResources(doc.resources as Json, ['resources'], out);
    checkExpressions(doc, out);
    if (isObj(doc.outputs)) {
      for (const [name, o] of Object.entries(doc.outputs)) {
        if (isObj(o) && /^secure/i.test(str(o.type) ?? '')) {
          out.push(warning('arm.output.secure', `Output ${name} is secure-typed; its value is not returned, so nothing downstream can read it.`, { path: pathString(['outputs', name]) }));
        }
      }
    }
    return out;
  },
  itemTitle: (value) => (isObj(value) ? str(value.name) ?? str(value.type) : undefined),
};

export const azureParameters: Profile = {
  id: 'azure-arm-parameters',
  family: 'azure',
  label: 'Azure deployment parameters file',
  format: 'json',
  source: ARM_SOURCE,
  detect: (doc) => (isParameters(doc) ? 0.95 : 0),
  choices: (path) => (path.length === 1 && last(path) === '$schema' ? [PARAMETERS_SCHEMA] : undefined),
  validate(doc) {
    const out: Finding[] = [];
    if (!isParameters(doc)) return out;
    if (!isObj(doc.parameters)) return [error('arm.parameters.missing', 'A parameters file needs parameters.', { path: '', source: ARM_SOURCE })];
    for (const [name, p] of Object.entries(doc.parameters)) {
      if (!isObj(p) || (!('value' in p) && !('reference' in p))) {
        out.push(error('arm.parameters.value', `Parameter ${name} needs a value or a Key Vault reference.`, { path: pathString(['parameters', name]), source: ARM_SOURCE }));
        continue;
      }
      if (isSecretPath([name]) && typeof p.value === 'string' && p.value !== '') {
        out.push(warning('arm.parameters.secret', `Parameter ${name} carries a secret in clear text.`, { path: pathString(['parameters', name, 'value']), remediation: 'Replace value with a Key Vault reference: {"reference": {"keyVault": {"id": …}, "secretName": …}}.' }));
      }
    }
    return out;
  },
};

// ---------------------------------------------------------------------------
// Azure Policy
// ---------------------------------------------------------------------------

export const POLICY_EFFECTS = ['addToNetworkGroup', 'append', 'audit', 'auditIfNotExists', 'deny', 'denyAction', 'deployIfNotExists', 'disabled', 'manual', 'modify', 'mutate'];
const OPERATORS = new Set([
  'equals', 'notEquals', 'like', 'notLike', 'match', 'matchInsensitively', 'notMatch', 'notMatchInsensitively', 'contains',
  'notContains', 'in', 'notIn', 'containsKey', 'notContainsKey', 'less', 'lessOrEquals', 'greater', 'greaterOrEquals', 'exists',
]);
const CONDITION_KEYS = new Set(['field', 'value', 'count', 'source', 'where', 'name']);

function policyBody(doc: Json): { body: Record<string, Json>; at: string[] } | undefined {
  if (!isObj(doc)) return undefined;
  if (isObj(doc.policyRule)) return { body: doc, at: [] };
  if (isObj(doc.properties) && isObj(doc.properties.policyRule)) return { body: doc.properties, at: ['properties'] };
  return undefined;
}

function checkCondition(node: Json, path: (string | number)[], out: Finding[]): void {
  if (!isObj(node)) {
    out.push(error('policy.condition.shape', 'A condition must be an object.', { path: pathString(path), source: POLICY_SOURCE }));
    return;
  }
  for (const logical of ['allOf', 'anyOf'] as const) {
    if (logical in node) {
      if (!Array.isArray(node[logical])) out.push(error('policy.logical', `${logical} takes a list of conditions.`, { path: pathString([...path, logical]), source: POLICY_SOURCE }));
      else (node[logical] as Json[]).forEach((c, i) => checkCondition(c, [...path, logical, i], out));
      return;
    }
  }
  if ('not' in node) {
    checkCondition(node.not as Json, [...path, 'not'], out);
    return;
  }
  const ops = Object.keys(node).filter((k) => !CONDITION_KEYS.has(k));
  if (!('field' in node) && !('value' in node) && !('count' in node)) {
    out.push(error('policy.condition.subject', 'A condition needs field, value or count.', { path: pathString(path), source: POLICY_SOURCE }));
  }
  if (ops.length !== 1) {
    out.push(error('policy.condition.operator', `A condition takes one operator; this has ${ops.length === 0 ? 'none' : ops.join(', ')}.`, { path: pathString(path), source: POLICY_SOURCE }));
  }
  for (const op of ops) {
    if (!OPERATORS.has(op)) {
      const guess = didYouMean(op, OPERATORS);
      out.push(error('policy.condition.unknown-operator', `${op} is not a condition operator.${guess ? ` Did you mean ${guess}?` : ''}`, { path: pathString([...path, op]), source: POLICY_SOURCE }));
    }
  }
  if (isObj(node.count) && 'where' in node.count) checkCondition(node.count.where as Json, [...path, 'count', 'where'], out);
}

export const azurePolicy: Profile = {
  id: 'azure-policy',
  family: 'azure',
  label: 'Azure Policy definition',
  format: 'json',
  source: POLICY_SOURCE,
  detect: (doc) => (policyBody(doc) ? 0.95 : 0),
  choices(path: Path, doc: Json) {
    const keys = keysOf(path);
    const key = last(path);
    const p = policyBody(doc);
    const rel = p ? keys.slice(p.at.length) : keys;
    if (rel.join('.') === 'policyRule.then.effect') return POLICY_EFFECTS;
    if (rel.join('.') === 'mode') return ['All', 'Indexed', 'Microsoft.Kubernetes.Data', 'Microsoft.KeyVault.Data', 'Microsoft.Network.Data', 'Microsoft.ManagedHSM.Data', 'Microsoft.DataFactory.Data'];
    if (rel.join('.') === 'policyType') return ['Custom', 'BuiltIn', 'Static', 'NotSpecified'];
    if (rel[0] === 'parameters' && rel.length === 3 && key === 'type') return ['String', 'Array', 'Object', 'Boolean', 'Integer', 'Float', 'DateTime'];
    if (rel[0] === 'parameters' && rel.length === 3 && key === 'defaultValue' && p && isObj(p.body.parameters)) {
      const param = p.body.parameters[rel[1] as string];
      if (isObj(param) && Array.isArray(param.allowedValues) && param.allowedValues.every((v) => typeof v === 'string')) return param.allowedValues as string[];
    }
    if (key === 'operation' && keys.includes('operations')) return ['addOrReplace', 'Add', 'Remove'];
    return undefined;
  },
  validate(doc) {
    const out: Finding[] = [];
    const p = policyBody(doc);
    if (!p) return out;
    const at = (...rest: (string | number)[]) => pathString([...p.at, ...rest]);
    const rule = p.body.policyRule as Record<string, Json>;
    if (!('if' in rule)) out.push(error('policy.if', 'policyRule needs an if.', { path: at('policyRule'), source: POLICY_SOURCE }));
    else checkCondition(rule.if as Json, [...p.at, 'policyRule', 'if'], out);
    const then = rule.then;
    if (!isObj(then)) {
      out.push(error('policy.then', 'policyRule needs a then with an effect.', { path: at('policyRule'), source: POLICY_SOURCE }));
      return out;
    }
    const effect = str(then.effect);
    const params = isObj(p.body.parameters) ? p.body.parameters : {};
    let effects: string[] = [];
    if (!effect) out.push(error('policy.effect.missing', 'then needs an effect.', { path: at('policyRule', 'then'), source: POLICY_SOURCE }));
    else {
      const ref = /^\[parameters\('([^']+)'\)\]$/.exec(effect);
      if (ref) {
        const param = params[ref[1] as string];
        if (!isObj(param)) out.push(error('policy.effect.parameter', `The effect comes from parameter ${ref[1]}, which is not declared.`, { path: at('policyRule', 'then', 'effect'), source: POLICY_SOURCE }));
        else effects = Array.isArray(param.allowedValues) ? param.allowedValues.map(String) : [String(param.defaultValue ?? '')];
      } else effects = [effect];
      for (const e of effects) {
        if (e && !POLICY_EFFECTS.some((x) => x.toLowerCase() === e.toLowerCase())) {
          out.push(error('policy.effect.unknown', `${e} is not a policy effect.`, { path: at('policyRule', 'then', 'effect'), source: POLICY_SOURCE }));
        }
      }
    }
    const needsDetails = effects.map((e) => e.toLowerCase()).filter((e) => ['deployifnotexists', 'modify', 'auditifnotexists', 'append', 'denyaction'].includes(e));
    if (needsDetails.length && !('details' in then)) {
      out.push(error('policy.details', `A ${needsDetails[0]} effect needs details.`, { path: at('policyRule', 'then'), source: POLICY_SOURCE }));
    }
    if (effects.some((e) => /^(deployifnotexists|modify)$/i.test(e)) && isObj(then.details) && !Array.isArray(then.details.roleDefinitionIds)) {
      out.push(error('policy.roles', 'DeployIfNotExists and Modify need details.roleDefinitionIds, the roles the remediation identity is given.', { path: at('policyRule', 'then', 'details'), source: POLICY_SOURCE }));
    }
    // parameters('x') used in the rule must be declared.
    const text = JSON.stringify(rule);
    for (const name of new Set([...text.matchAll(/parameters\('([^']+)'\)/g)].map((m) => m[1] as string))) {
      if (!(name in params)) out.push(error('policy.parameter.unknown', `The rule uses parameter ${name}, which is not declared.`, { path: at('parameters'), source: POLICY_SOURCE }));
    }
    return out;
  },
};
