/**
 * A script, as the files someone can use.
 *
 * Two of them: the script itself, and the README that goes in the ticket or
 * beside it in a repository. They come from one structure, so the README cannot
 * describe a script that does something else — which is the usual fate of a
 * README written separately a week later.
 */

                                                                                   
import { slug } from '../kit/blueprint.js';
                                                   
import { SCRIPT_PLATFORMS, renderReadme, renderScript, standingFindings,                                  } from './script.js';

                                                    
                                                                 
                                    
                                                           
                                                                     
 

export function scriptFiles(script        , name        )              {
  const platform = SCRIPT_PLATFORMS[script.platform];
  const base = slug(name, 'script').replace(/_/g, '-');
  const findings            = [...(script.findings ?? []), ...standingFindings(script)];

  return {
    files: {
      [`${base}${platform.extension}`]: renderScript(script, base),
      'README.md': `${renderReadme(script, base).join('\n')}\n`,
    },
    findings,
  };
}

/**
 * Declare a blueprint from a script builder.
 *
 * The page sees an ordinary `Blueprint`; the bundle sees the structured script
 * underneath it. Writing both by hand is how the two would eventually disagree.
 */
export function scriptBlueprint(
  spec                                        
                                      
                                       
                                                                       
   ,
)                  {
  return {
    ...spec,
    emits: spec.emits ?? [],
    build: (values                 , name        ) => scriptFiles(spec.script(values, name), name),
  };
}
