/**
 * What every hand-written scenario blueprint shares — VMware, Linux and Windows.
 *
 * A scenario is several resources that are built together — a cluster with
 * its DRS rules, a Tier-1 gateway with its segments and firewall — written out
 * the way the per-resource blueprints cannot. Around each one the same
 * `terraform` block, provider block and connection fields are generated as
 * for the per-resource blueprints, so the two kinds read alike and the
 * credentials are handled once: as sensitive variables, never as text.
 */

                                                                                                         
                                                      
import { newEmitted, PROVIDER_META, providerInputs, wrapConfiguration,                     } from '../schema-blueprints.js';

                                     
                      
                         
                               
                                             
                                                             
                                    
     
                                                                             
                                                                      
                       
     
                                                
                                                                        
                          
                                                                                                       
                                                                                                                                    
 

export function scenarioGroup(provider                )         {
  return `${PROVIDER_META[provider].product} · Scenarios (several resources together)`;
}

export function scenario(provider                , definition                    )            {
  const providers = [provider, ...(definition.alsoUses ?? [])];
  return {
    id: definition.id,
    label: definition.label,
    group: definition.group ?? scenarioGroup(provider),
    description: definition.description,
    inputs: [...definition.inputs, ...[...new Set(providers)].flatMap((p) => providerInputs(p))],
    emits: definition.emits,
    build: (values                 , name        ) => {
      const produced = definition.body(values                  , name || definition.id);
      const hcl = typeof produced === 'string' ? produced : produced.hcl;
      const findings = typeof produced === 'string' ? [] : produced.findings;
      const out = newEmitted();
      const main = wrapConfiguration(providers, values, [hcl.trim()], out);
      return { files: { 'main.tf': main }, findings: [...findings, ...out.findings] };
    },
  };
}

// --- small template helpers --------------------------------------------------

/** A quoted HCL string, or the reference itself when the value is one. */
export function q(value         )         {
  const text = String(value ?? '').trim();
  if (/^(var|local|data|module)\.[\w.[\]"*-]+$/.test(text) || /^[a-z][a-z0-9]*_[a-z0-9_]+\.[A-Za-z_][\w-]*\.[\w.[\]]+$/.test(text)) return text;
  // A function replacement: in a replacement string `$$` is itself an escape
  // for `$`, so '$${' would write `${` back and reopen the interpolation.
  return JSON.stringify(text).replace(/\$\{/g, () => '$${').replace(/%\{/g, () => '%%{');
}

/** A comma- or newline-separated field as a list of strings. */
export function items(value         )           {
  return String(value ?? '')
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** `["a", "b"]` from a comma-separated field. */
export function qlist(value         )         {
  return `[${items(value).map(q).join(', ')}]`;
}

/** Lines of `name=value` (or `name value`) as pairs. */
export function pairs(value         )                     {
  return String(value ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const m = /^([^=\s:]+)\s*[=:\s]\s*(.*)$/.exec(line);
      return m ? [m[1]          , (m[2] ?? '').trim()] : [line, ''];
    });
}

/** A Terraform identifier from a free-text name. */
export function ident(value         , fallback = 'this')         {
  const id = String(value ?? '').trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  if (id === '') return fallback;
  return /^[a-z_]/.test(id) ? id : `n_${id}`;
}

export function on(value         )          {
  return value === true || value === 'true' || value === 'yes';
}

export function n(value         , fallback        )         {
  const v = Number(value);
  return Number.isFinite(v) && String(value).trim() !== '' ? v : fallback;
}

export const YES_NO_OPTIONS = [
  { value: 'true', label: 'Yes' },
  { value: 'false', label: 'No' },
];
