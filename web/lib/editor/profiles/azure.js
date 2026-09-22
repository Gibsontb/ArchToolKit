/**
 * Azure: ARM templates, their parameter files, and Azure Policy definitions.
 *
 * ARM checks are the ones deployment validation applies first: the template
 * sections, each resource's type, apiVersion and name, parameter types, and
 * every `parameters('…')` and `variables('…')` naming something declared.
 * Policy checks are the rule grammar and the effects.
 *
 * Bicep compiles to an ARM template, so a `bicep build` output opens here.
 */

import { error, warning,              } from '../../core/findings.js';
import { isSecretPath, pathString,                      } from '../doc.js';
import { didYouMean, isObj, keysOf, last, str,              } from '../profile.js';

const ARM_SOURCE = 'ARM template structure and syntax (learn.microsoft.com/azure/azure-resource-manager/templates/syntax)';
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

function isTemplate(doc      )                              {
  if (!isObj(doc)) return false;
  const schema = str(doc.$schema) ?? '';
  if (/DeploymentTemplate\.json/i.test(schema)) return true;
  return 'contentVersion' in doc && 'resources' in doc;
}

function isParameters(doc      )                              {
  return isObj(doc) && /deploymentParameters\.json/i.test(str(doc.$schema) ?? '');
}

/** Resources, whether as the usual list or languageVersion 2.0's object keyed by symbolic name. */
function resourceEntries(value                  )                            {
  if (Array.isArray(value)) return value.map((r, i) => [i, r]);
  if (isObj(value)) return Object.entries(value);
  return [];
}

function checkResources(list                  , at                     , out           )       {
  for (const [key, r] of resourceEntries(list)) {
    const path = [...at, key];
    if (!isObj(r)) continue;
    if ('existing' in r && r.existing === true) continue;
    const type = str(r.type);
    if (!type) out.push(error('arm.resource.type', 'A resource needs a type.', { path: pathString(path), source: ARM_SOURCE }));
    else if (!TYPE_RE.test(type) && !type.startsWith('[')) {
      out.push(error('arm.resource.type-format', `${type} is not a resource type; types are written Namespace/type, as Microsoft.Storage/storageAccounts.`, { path: pathString([...path, 'type']), source: ARM_SOURCE }));
    }
    const api = str(r.apiVersion);
    if (!api) out.push(error('arm.resource.apiVersion', `${type ?? 'This resource'} has no apiVersion.`, { path: pathString(path), source: ARM_SOURCE }));
    else if (!API_VERSION_RE.test(api)) out.push(error('arm.resource.apiVersion-format', `${api} is not an API version; they are dates, as 2023-05-01.`, { path: pathString([...path, 'apiVersion']), source: ARM_SOURCE }));
    else if (/-preview$/.test(api)) out.push(warning('arm.resource.preview', `${type} uses a preview API version, which can change or be withdrawn.`, { path: pathString([...path, 'apiVersion']) }));
    if (!('name' in r)) out.push(error('arm.resource.name', `${type ?? 'This resource'} has no name.`, { path: pathString(path), source: ARM_SOURCE }));
    if ('resources' in r) checkResources(r.resources        , [...path, 'resources'], out);
  }
}

/** `[parameters('x')]` and `[variables('y')]` inside every expression string. */
function checkExpressions(doc                      , out           )       {
  const params = new Set(isObj(doc.parameters) ? Object.keys(doc.parameters) : []);
  const vars = new Set(isObj(doc.variables) ? Object.keys(doc.variables) : []);
  if (isObj(doc.variables) && Array.isArray(doc.variables.copy)) {
    for (const c of doc.variables.copy) if (isObj(c) && typeof c.name === 'string') vars.add(c.name);
  }
  const walk = (node      , path                     )       => {
    if (typeof node === 'string') {
      if (!node.startsWith('[') || node.startsWith('[[')) return;
      for (const m of node.matchAll(/\b(parameters|variables)\(\s*'([^']+)'\s*\)/g)) {
        const [, fn, name] = m                                       ;
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
  for (const section of ['variables', 'resources', 'outputs']         ) if (section in doc) walk(doc[section]        , [section]);
}

export const azureArm          = {
  id: 'azure-arm',
  family: 'azure',
  label: 'Azure Resource Manager template',
  format: 'json',
  source: ARM_SOURCE,
  detect: (doc) => (isTemplate(doc) ? 0.95 : 0),
  choices(path      , doc      ) {
    const keys = keysOf(path);
    const key = last(path);
    if (keys.length === 1 && key === '$schema') return TEMPLATE_SCHEMAS;
    if ((keys[0] === 'parameters' || keys[0] === 'outputs') && keys.length === 3 && key === 'type') return PARAM_TYPES;
    if (keys[0] === 'parameters' && keys.length === 3 && key === 'defaultValue' && isObj(doc) && isObj(doc.parameters)) {
      const p = doc.parameters[keys[1]          ];
      if (isObj(p) && Array.isArray(p.allowedValues) && p.allowedValues.every((v) => typeof v === 'string')) return p.allowedValues            ;
    }
    if (keys.length === 1 && key === 'languageVersion') return ['2.0'];
    return undefined;
  },
  validate(doc) {
    const out            = [];
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
    else if (!/^\d+\.\d+\.\d+\.\d+$/.test(str(doc.contentVersion)          )) {
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
    checkResources(doc.resources        , ['resources'], out);
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

export const azureParameters          = {
  id: 'azure-arm-parameters',
  family: 'azure',
  label: 'Azure deployment parameters file',
  format: 'json',
  source: ARM_SOURCE,
  detect: (doc) => (isParameters(doc) ? 0.95 : 0),
  choices: (path) => (path.length === 1 && last(path) === '$schema' ? [PARAMETERS_SCHEMA] : undefined),
  validate(doc) {
    const out            = [];
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

function policyBody(doc      )                                                           {
  if (!isObj(doc)) return undefined;
  if (isObj(doc.policyRule)) return { body: doc, at: [] };
  if (isObj(doc.properties) && isObj(doc.properties.policyRule)) return { body: doc.properties, at: ['properties'] };
  return undefined;
}

function checkCondition(node      , path                     , out           )       {
  if (!isObj(node)) {
    out.push(error('policy.condition.shape', 'A condition must be an object.', { path: pathString(path), source: POLICY_SOURCE }));
    return;
  }
  for (const logical of ['allOf', 'anyOf']         ) {
    if (logical in node) {
      if (!Array.isArray(node[logical])) out.push(error('policy.logical', `${logical} takes a list of conditions.`, { path: pathString([...path, logical]), source: POLICY_SOURCE }));
      else (node[logical]          ).forEach((c, i) => checkCondition(c, [...path, logical, i], out));
      return;
    }
  }
  if ('not' in node) {
    checkCondition(node.not        , [...path, 'not'], out);
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
  if (isObj(node.count) && 'where' in node.count) checkCondition(node.count.where        , [...path, 'count', 'where'], out);
}

export const azurePolicy          = {
  id: 'azure-policy',
  family: 'azure',
  label: 'Azure Policy definition',
  format: 'json',
  source: POLICY_SOURCE,
  detect: (doc) => (policyBody(doc) ? 0.95 : 0),
  choices(path      , doc      ) {
    const keys = keysOf(path);
    const key = last(path);
    const p = policyBody(doc);
    const rel = p ? keys.slice(p.at.length) : keys;
    if (rel.join('.') === 'policyRule.then.effect') return POLICY_EFFECTS;
    if (rel.join('.') === 'mode') return ['All', 'Indexed', 'Microsoft.Kubernetes.Data', 'Microsoft.KeyVault.Data', 'Microsoft.Network.Data', 'Microsoft.ManagedHSM.Data', 'Microsoft.DataFactory.Data'];
    if (rel.join('.') === 'policyType') return ['Custom', 'BuiltIn', 'Static', 'NotSpecified'];
    if (rel[0] === 'parameters' && rel.length === 3 && key === 'type') return ['String', 'Array', 'Object', 'Boolean', 'Integer', 'Float', 'DateTime'];
    if (rel[0] === 'parameters' && rel.length === 3 && key === 'defaultValue' && p && isObj(p.body.parameters)) {
      const param = p.body.parameters[rel[1]          ];
      if (isObj(param) && Array.isArray(param.allowedValues) && param.allowedValues.every((v) => typeof v === 'string')) return param.allowedValues            ;
    }
    if (key === 'operation' && keys.includes('operations')) return ['addOrReplace', 'Add', 'Remove'];
    return undefined;
  },
  validate(doc) {
    const out            = [];
    const p = policyBody(doc);
    if (!p) return out;
    const at = (...rest                     ) => pathString([...p.at, ...rest]);
    const rule = p.body.policyRule                        ;
    if (!('if' in rule)) out.push(error('policy.if', 'policyRule needs an if.', { path: at('policyRule'), source: POLICY_SOURCE }));
    else checkCondition(rule.if        , [...p.at, 'policyRule', 'if'], out);
    const then = rule.then;
    if (!isObj(then)) {
      out.push(error('policy.then', 'policyRule needs a then with an effect.', { path: at('policyRule'), source: POLICY_SOURCE }));
      return out;
    }
    const effect = str(then.effect);
    const params = isObj(p.body.parameters) ? p.body.parameters : {};
    let effects           = [];
    if (!effect) out.push(error('policy.effect.missing', 'then needs an effect.', { path: at('policyRule', 'then'), source: POLICY_SOURCE }));
    else {
      const ref = /^\[parameters\('([^']+)'\)\]$/.exec(effect);
      if (ref) {
        const param = params[ref[1]          ];
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
    for (const name of new Set([...text.matchAll(/parameters\('([^']+)'\)/g)].map((m) => m[1]          ))) {
      if (!(name in params)) out.push(error('policy.parameter.unknown', `The rule uses parameter ${name}, which is not declared.`, { path: at('parameters'), source: POLICY_SOURCE }));
    }
    return out;
  },
};
