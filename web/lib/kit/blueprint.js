/**
 * A blueprint is a thing you can build, with the inputs it needs.
 *
 * The generators were previously shaped around the cloud rather than the
 * output: you ticked providers and got the one thing the kit knew how to make.
 * That is backwards. You pick the platform once, then you pick *what you are
 * building* — an EC2 instance with a security group, a versioned S3 bucket, a
 * VM from a vSphere template — and fill in that thing's parameters.
 *
 * So a blueprint owns its own inputs, and the page is generic: it renders
 * whatever the selected blueprint declares and calls `build`. Adding a
 * blueprint is adding one object to one file; no page code changes.
 *
 * Input controls exist so that a choice with a known set of answers is a
 * dropdown rather than a text box someone can misspell. A region, an instance
 * size, an encryption algorithm, a disk mode — all of those have answers the
 * provider will accept and answers it will reject, and offering a free-text box
 * for them just moves the error to plan time.
 */

                                                   

                          
                                                                              
            
     
                                                                              
                                                                       
                                                                              
     
           
          
            
            
              
                                                                                
               
                                                                                                          
                   

                               
                         
                         
     
                                                                     
    
                                                                             
                                                                                
                                                                                
                                                                       
     
                          
 

                                 
                      
                         
                                 
                                                                            
                         
                                               
                                                                         
                                             
                        
                        
                                
     
                                                                          
                                                                       
    
                                                                                
                                                                              
                                                                    
     
                       
                           
                                        
                                           
    
     
                                                                          
                                                                               
                                                                              
                                                                          
     
                            
                                                                                
                         
     
                                                                              
                                                                               
                                                                              
     
                               
     
                                                                              
                                                                           
                                        
     
                                                        
 

/** Values as the page collects them, keyed by input id. */
                                  
                                                               
 

/**
 * The same values as a ported template reads them.
 *
 * The blueprint templates came over verbatim from the previous toolkit, where
 * they were JavaScript and read their inputs with dot access and no narrowing —
 * `vals.backend_ip.split(',')` and the like. Retyping each of those by hand
 * would mean editing sixty-four working templates to satisfy a compiler, and
 * every edit is a chance to change what one emits. So the adapter boundary is
 * explicit and lives here, rather than being spread through the templates.
 */
                                 
                                                                
                             
 

/** One resource the generated configuration will, will not, or may create. */
                               
                           
                                            
                                                           
                           
                                               
                             
 

                              
                                                                              
                                                   
                                         
     
                                                                          
                                                                             
                                                       
     
                                            
 

                            
                      
                         
     
                                                                            
    
                                                                                
                                                                             
                                                              
                                                                            
                       
     
                          
                                                                             
                               
                                             
     
                                                                       
                                                                            
                                 
     
                                    
                                                                         
 

                                 
                                                            
                          
                         
                                            
 

// --- value helpers ---------------------------------------------------------
// Blueprints read their values through these so an empty box falls back to the
// declared default rather than emitting an empty string into a configuration.

export function str(values                 , id        , fallback = '')         {
  const value = values[id];
  if (value === undefined || value === null) return fallback;
  const text = String(value).trim();
  return text === '' ? fallback : text;
}

export function num(values                 , id        , fallback        )         {
  const value = Number(values[id]);
  return Number.isFinite(value) ? value : fallback;
}

export function bool(values                 , id        , fallback = false)          {
  const value = values[id];
  if (value === undefined) return fallback;
  if (typeof value === 'boolean') return value;
  return value === 'true' || value === 'yes' || value === '1';
}

/** Defaults for every input, for a first render and for tests. */
export function defaultValues(blueprint           )                  {
  const values                                            = {};
  for (const input of blueprint.inputs) {
    if (input.default !== undefined) {
      values[input.id] = input.default;
    } else if (input.blankLabel !== undefined) {
      // Empty is an answer here — "leave it to the module" — and the only
      // right starting point. Taking the first option instead wrote
      // `create_spot_instance = true` into every EC2 call nobody asked for.
      values[input.id] = '';
    } else if (input.control === 'select' && input.options?.[0] !== undefined) {
      values[input.id] = input.options[0].value;
    } else if (input.control === 'toggle') {
      values[input.id] = false;
    } else if (input.control === 'number') {
      // A number with a section is an optional module input: empty means the
      // module's default, where 0 would mean zero.
      values[input.id] = input.section !== undefined ? '' : (input.min ?? 0);
    } else {
      values[input.id] = '';
    }
  }
  return values;
}

/**
 * Whether an input should be shown, given what has been filled in so far.
 *
 * `equals` is the common case — show the VLAN list when the port is a trunk.
 * `notEquals` exists for the inputs whose controlling answer is "none", which a
 * list of the values that are not none cannot express: an OSPF process number
 * where 0 means "do not add this interface to OSPF" has four billion values
 * that are not 0.
 */
export function isVisible(input                , values                 )          {
  if (!input.showWhen) return true;
  const current = String(values[input.showWhen.input] ?? '');
  const { equals, notEquals } = input.showWhen;
  if (notEquals && notEquals.includes(current)) return false;
  if (!equals || equals.length === 0) return notEquals !== undefined;
  return equals.includes(current);
}

export function blueprintsFor(groups                           , target        )                       {
  return groups.find((g) => g.target === target)?.blueprints ?? [];
}

export function findBlueprint(
  groups                           ,
  target        ,
  id        ,
)                        {
  return blueprintsFor(groups, target).find((b) => b.id === id);
}

/**
 * A safe identifier for a generated name.
 *
 * Terraform labels and Ansible names both reject most punctuation, and a name
 * typed by a person routinely contains a space or a dot.
 */
export function slug(value        , fallback        )         {
  const cleaned = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return cleaned === '' ? fallback : cleaned;
}
