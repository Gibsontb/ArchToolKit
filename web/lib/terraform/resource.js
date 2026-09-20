/**
 * Emit any resource, for any provider in the kit.
 *
 * The hand-verified emitters cover the cases worth getting exactly right. This
 * covers the rest: give it a type and a set of arguments and it renders valid
 * HCL, checking the type against the catalog first so a misremembered name is
 * caught here rather than at plan time.
 *
 * It deliberately does not validate arguments. The catalog knows which resources
 * exist, not what each one takes, and inventing that would be the same mistake
 * as generating resources from memory. What it can do is be honest: the type is
 * checked, the values are rendered faithfully, and anything it cannot vouch for
 * is said plainly.
 */

import { error, info, warning,              } from '../core/findings.js';
import {
  renderFile,
  str,
  num,
  bool,
  list,
  raw,
                
                    
                
} from './hcl.js';
import { classifyType, catalogueFor } from './catalog.js';
import { providerFor,                  } from './providers.js';
import { identifier } from './foundation.js';

/** A value as a caller supplies it, before it becomes HCL. */
                           
          
          
           
                            
                                                                          
                                   
                                                                  
                                                             

                              
                                         
 

                                      
                               
                                              
                        
                                                                          
                         
                                  
                                                            
                                
 

function isExpression(value               )                                           {
  return typeof value === 'object' && value !== null && 'expression' in value;
}

function isBlock(value               )                                                                    {
  return typeof value === 'object' && value !== null && 'block' in value;
}

function toHcl(value                                            )           {
  if (isExpression(value)) return raw(value.expression);
  if (typeof value === 'string') return str(value);
  if (typeof value === 'number') return num(value);
  if (typeof value === 'boolean') return bool(value);
  if (Array.isArray(value)) {
    return list(
      value
        .filter((v)                                                  => !isBlock(v))
        .map(toHcl),
    );
  }
  return str(String(value));
}

function buildBlock(args             )                                          {
  const attributes                 = [];
  const blocks             = [];

  for (const [name, value] of Object.entries(args)) {
    if (value === undefined) continue;
    if (isBlock(value)) {
      const bodies = Array.isArray(value.block) ? value.block : [value.block];
      for (const body of bodies                          ) {
        blocks.push({ type: name, ...buildBlock(body) });
      }
      continue;
    }
    attributes.push({ name, value: toHcl(value) });
  }
  return { attributes, blocks };
}

                                     
                       
                                        
 

export function emitResource(options                     )                     {
  const findings            = [];
  const provider = providerFor(options.target);
  const kind = classifyType(options.target, options.type);
  const wantsData = options.dataSource === true;

  if (kind === 'unknown') {
    const entry = catalogueFor(options.target);
    findings.push(
      error(
        'terraform.resource.unknown-type',
        `"${options.type}" is not a resource or data source in ${provider.source}${entry ? ` ${entry.version}` : ''}.`,
        {
          path: 'type',
          remediation:
            'Check the name against the catalog, or run npm run catalog:update if the provider is newer than the catalog.',
          source: 'Terraform Registry catalog',
        },
      ),
    );
  } else if (kind === 'uncatalogued') {
    findings.push(
      warning(
        'terraform.resource.uncatalogued-provider',
        `${provider.label} is not in the catalog, so "${options.type}" could not be checked.`,
        { remediation: 'Run npm run catalog:update.', source: 'ArchToolKit' },
      ),
    );
  } else if (wantsData && kind === 'resource') {
    findings.push(
      warning(
        'terraform.resource.kind-mismatch',
        `"${options.type}" is a resource, but a data block was asked for.`,
        { path: 'dataSource' },
      ),
    );
  } else if (!wantsData && kind === 'data-source') {
    findings.push(
      warning(
        'terraform.resource.kind-mismatch',
        `"${options.type}" is a data source, but a resource block was asked for.`,
        { path: 'dataSource' },
      ),
    );
  }

  const prefix = options.target === 'azure' ? 'azurerm_' : `${options.target}_`;
  const label =
    options.name ??
    identifier(options.type.startsWith(prefix) ? options.type.slice(prefix.length) : options.type);

  const block           = {
    type: wantsData ? 'data' : 'resource',
    labels: [options.type, label || 'this'],
    ...buildBlock(options.arguments),
  };

  if (Object.keys(options.arguments).length === 0) {
    findings.push(
      warning('terraform.resource.no-arguments', 'No arguments were given, so an empty block was emitted.', {
        path: 'arguments',
      }),
    );
  }

  findings.push(
    info(
      'terraform.resource.arguments-not-validated',
      'Argument names are rendered as given. The catalog knows which resources exist, not what each one accepts, so run terraform validate before relying on this.',
      { source: 'ArchToolKit' },
    ),
  );

  return { hcl: renderFile([block]), findings };
}
