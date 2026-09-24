/**
 * An automation, as the files someone can apply.
 *
 * Whatever the platform wants — a suite-API payload, a cloud template, a
 * runbook — plus the README that carries the contract. They come from one
 * structure, so the README cannot describe an automation that does something
 * else, which is the usual fate of a README written a week later by someone
 * who was told what it was meant to do.
 */

                                                                                   
                                                   
import { renderReadme, slugOf,                                          } from './automation.js';

                                                        
                                                                   
                                        
                                                                   
                                                                             
 

export function automationFiles(automation            , name        )              {
  const base = slugOf(name, 'automation');
  // Errors and warnings about the values given. General advice (info) is not shown.
  const findings            = (automation.findings ?? []).filter((finding) => finding.severity !== 'info');

  return {
    files: {
      ...automation.files,
      'README.md': renderReadme(automation, base),
    },
    findings,
  };
}

/**
 * Declare a blueprint from an automation builder.
 *
 * The page sees an ordinary `Blueprint`; the tests see the structure
 * underneath, which is how they can check that everything irreversible has a
 * guardrail without reading the generated YAML.
 */
export function automationBlueprint(
  spec                                        
                                          
                                       
                                                                               
   ,
)                      {
  return {
    ...spec,
    emits: spec.emits ?? [],
    build: (values                 , name        ) => automationFiles(spec.automation(values, name), name),
  };
}
