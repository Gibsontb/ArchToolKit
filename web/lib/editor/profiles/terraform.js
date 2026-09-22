/**
 * Terraform in JSON syntax (*.tf.json) and variable files (*.tfvars.json, or
 * YAML the pipeline turns into one).
 *
 * The resource and data-source types are checked against the provider
 * catalog the Terraform kit already carries (npm run catalog:update), for the
 * providers it covers: vcf, vsphere, aws, azurerm, google, oci. A variable
 * whose name says it holds a secret should be marked sensitive, or its value
 * lands in plan output and logs.
 */

import { classifyType, catalogueFor, dataSourceTypes, nearestTypes, resourceTypes } from '../../terraform/catalog.js';
                                                                
import { error, info, warning,              } from '../../core/findings.js';
import { isSecretPath, pathString, secretPaths,                      } from '../doc.js';
import { didYouMean, isObj, keysOf, last, str,              } from '../profile.js';

const SOURCE = 'Terraform JSON configuration syntax (developer.hashicorp.com/terraform/language/syntax/json)';

const TOP_LEVEL = new Set(['terraform', 'provider', 'variable', 'output', 'locals', 'module', 'resource', 'data', 'moved', 'import', 'check', 'removed', '//']);

const PREFIXES                                   = [
  ['azurerm_', 'azure'],
  ['google_', 'google'],
  ['aws_', 'aws'],
  ['oci_', 'oci'],
  ['vsphere_', 'vsphere'],
  ['vcf_', 'vcf'],
];

function targetOf(type        )                          {
  return PREFIXES.find(([p]) => type.startsWith(p))?.[1];
}

/** `resource` as an object, or as the list of objects the JSON syntax also allows. */
function blocks(value                  )                         {
  if (Array.isArray(value)) return value.filter(isObj);
  return isObj(value) ? [value] : [];
}

function checkTypes(block                     , value                  , out           )       {
  blocks(value).forEach((group, gi) => {
    const prefix                      = Array.isArray(value) ? [block, gi] : [block];
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

export const terraformJson          = {
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
  choices(path      ) {
    const keys = keysOf(path);
    const key = last(path);
    if (keys[0] === 'variable' && key === 'type' && keys.length === 3) {
      return ['string', 'number', 'bool', 'list(string)', 'list(number)', 'set(string)', 'map(string)', 'map(number)', 'any'];
    }
    return undefined;
  },
  validate(doc) {
    const out            = [];
    if (!isObj(doc)) return [error('tf.not-object', 'A .tf.json file is a JSON object.', { path: '' })];
    for (const key of Object.keys(doc)) {
      if (!TOP_LEVEL.has(key)) out.push(error('tf.top-level', `${key} is not a Terraform block type.`, { path: key, source: SOURCE }));
    }
    checkTypes('resource', doc.resource, out);
    checkTypes('data', doc.data, out);
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
  itemTitle: (value) => (isObj(value) ? str(value.name) : undefined),
};

export const terraformVars          = {
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
